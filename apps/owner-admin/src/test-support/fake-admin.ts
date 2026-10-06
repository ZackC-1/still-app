// An in-memory stand-in for the product-policy-admin function, speaking its HTTP protocol
// (supabase/functions/product-policy-admin/handler.ts + migration 0016's apply rules): owner
// allowlist on every call, preview → apply with compare-and-set on the expected revision, preview
// hash and body binding, idempotent replay per operation, cutoff_required for an activating sales
// body, and its own readback. Knobs let a test break one step at a time.
import { createHash, randomUUID } from "node:crypto";
import {
  parseProductPolicy,
  PRODUCT_POLICY_SURFACES,
  SALES_CHANNELS,
  type ProductPolicyEnvironment,
  type ProductPolicyNamespace,
} from "@still/shared-types/product-policy";
import type { AdminTransport, HttpResult } from "../admin-client.js";

type Key = `${ProductPolicyNamespace}:${ProductPolicyEnvironment}`;
interface Revision { revision: number; body: string; operationId: string }
interface Operation {
  id: string;
  owner: string;
  namespace: ProductPolicyNamespace;
  environment: ProductPolicyEnvironment;
  expectedRevision: number;
  body: string;
  hash: string;
  status: "previewed" | "applied" | "stale" | "expired";
  appliedRevision?: number;
}

export const OWNER_TOKEN = "owner-session";
export const STRANGER_TOKEN = "stranger-session";

const ok = (status: number, body: unknown): HttpResult => ({ status, body });

/** The canonical rendering migration 0016 and policy-wire.ts produce (same key order). */
export function render(namespace: ProductPolicyNamespace, environment: string, revision: number, draft: Record<string, unknown>): string | null {
  const keys = namespace === "rating" ? ["builds", "master", "surfaces"] : ["builds", "channels", "salesEnabled"];
  if (Object.keys(draft).sort().join() !== keys.join()) return null;
  const builds = draft.builds as { surface: string; build: string }[];
  const head = `{"schema":1,"environment":"${environment}","revision":${revision},`;
  const tail = `"builds":[${(builds ?? []).map((b) => `{"surface":"${b.surface}","build":"${b.build}"}`).join(",")}]}`;
  let body: string;
  if (namespace === "rating") {
    const surfaces = draft.surfaces as Record<string, unknown>;
    body = `${head}"master":${draft.master},"surfaces":{${PRODUCT_POLICY_SURFACES.map((s) => `"${s}":${surfaces?.[s]}`).join(",")}},${tail}`;
  } else {
    const channels = draft.channels as Record<string, { enabled: unknown; offer: unknown }>;
    body = `${head}"salesEnabled":${draft.salesEnabled},"channels":{${SALES_CHANNELS.map(
      (c) => `"${c}":{"enabled":${channels?.[c]?.enabled},"offer":"${channels?.[c]?.offer}"}`,
    ).join(",")}},${tail}`;
  }
  try {
    parseProductPolicy(namespace, new TextEncoder().encode(body));
    return body;
  } catch {
    return null;
  }
}

function salesActivates(body: string): boolean {
  const v = JSON.parse(body) as {
    salesEnabled: boolean;
    channels: Record<string, { enabled: boolean }>;
    builds: { surface: string }[];
  };
  return v.salesEnabled && v.builds.some((b) =>
    (["chrome_desktop", "firefox_desktop", "firefox_android"].includes(b.surface) && v.channels.web!.enabled) ||
    (["apple_mobile_host", "apple_macos_host"].includes(b.surface) && v.channels.apple!.enabled));
}

export class FakeAdminFunction {
  readonly owners = new Map<string, string>([[OWNER_TOKEN, "00000000-0000-4000-8000-000000000001"]]);
  readonly signedIn = new Map<string, string>([[STRANGER_TOKEN, "00000000-0000-4000-8000-000000000002"]]);
  readonly history = new Map<Key, Revision[]>();
  readonly operations = new Map<string, Operation>();
  readonly calls: Record<string, unknown>[] = [];
  cutoff = false;

  // Knobs.
  /** Commit, then answer apply with this instead of the verified reply (the server's own readback lost). */
  afterCommit: "checking" | "drop" | "500" | null = null;
  afterCommitTimes = 1;
  /** Answer apply as "applied, verified" WITHOUT committing anything (a lying or broken server). */
  lieApplied = false;
  /** Fail apply with a 500 before anything is written. */
  failApply = false;
  /** Fail the next N read calls with a transport error. */
  failReads = 0;
  /** Another owner applies a change right before the next apply. */
  raceNextApply = false;
  /** Hold every read until the test releases it. */
  readGate: Promise<void> | null = null;

  /** Seed a namespace with an applied revision (as if applied earlier). */
  seed(namespace: ProductPolicyNamespace, environment: ProductPolicyEnvironment, draft: Record<string, unknown>) {
    const key: Key = `${namespace}:${environment}`;
    const list = this.history.get(key) ?? [];
    const revision = list.length + 1;
    const body = render(namespace, environment, revision, draft);
    if (!body) throw new Error("bad seed draft");
    list.push({ revision, body, operationId: randomUUID() });
    this.history.set(key, list);
  }

  current(namespace: ProductPolicyNamespace, environment: ProductPolicyEnvironment): Revision | null {
    const list = this.history.get(`${namespace}:${environment}`) ?? [];
    return list.at(-1) ?? null;
  }

  transport(token: () => string | null): AdminTransport {
    return async (request) => {
      this.calls.push(request);
      const t = token();
      if (!t || (!this.owners.has(t) && !this.signedIn.has(t))) return ok(401, { error: "unauthorized" });
      const owner = this.owners.get(t);
      if (request.action === "read" && this.readGate) await this.readGate;
      if (request.action === "read" && this.failReads > 0) {
        this.failReads--;
        return ok(0, null);
      }
      if (!owner) return ok(403, { error: "forbidden" });
      return this.handle(owner, request);
    };
  }

  private handle(owner: string, r: Record<string, unknown>): HttpResult {
    const namespace = r.namespace as ProductPolicyNamespace;
    const environment = r.environment as ProductPolicyEnvironment;
    const key: Key = `${namespace}:${environment}`;
    const list = this.history.get(key) ?? [];
    const head = list.at(-1);
    const revision = head?.revision ?? 0;

    if (r.action === "read") {
      return ok(200, {
        status: "current",
        revision,
        body: head?.body ?? null,
        operationId: head?.operationId ?? null,
        cutoff: this.cutoff,
        remote: {},
      });
    }

    if (r.action === "preview" || r.action === "preview-rollback") {
      const expected = r.expectedRevision as number;
      if (expected !== revision) return ok(409, { status: "stale", currentRevision: revision });
      let body: string | null;
      if (r.action === "preview") {
        body = render(namespace, environment, expected + 1, r.draft as Record<string, unknown>);
      } else {
        const source = list.find((x) => x.revision === r.sourceRevision);
        body = source ? source.body.replace(`"revision":${source.revision},`, `"revision":${expected + 1},`) : null;
      }
      if (!body) return ok(400, { error: "policy-invalid" });
      const id = randomUUID();
      const hash = createHash("sha256").update(`${id}|${owner}|${key}|${expected}|${body}`).digest("hex");
      this.operations.set(id, { id, owner, namespace, environment, expectedRevision: expected, body, hash, status: "previewed" });
      return ok(200, {
        status: "previewed",
        operationId: id,
        previewHash: hash,
        kind: r.action === "preview" ? "apply" : "rollback",
        rollbackOf: r.action === "preview" ? null : r.sourceRevision,
        expectedRevision: expected,
        revision: expected + 1,
        body,
        expiresAt: Date.now() + 300_000,
        before: {},
        after: {},
      });
    }

    if (r.action === "apply") {
      if (this.failApply) return ok(500, { error: "internal" });
      if (this.raceNextApply) {
        this.raceNextApply = false;
        const other = list.at(-1)?.body ?? render(namespace, environment, 1, namespace === "rating"
          ? { master: false, surfaces: Object.fromEntries(PRODUCT_POLICY_SURFACES.map((s) => [s, false])), builds: [] }
          : { salesEnabled: false, channels: { apple: { enabled: false, offer: "still-pro-v3" }, web: { enabled: false, offer: "still-pro-v3" } }, builds: [] })!;
        const next = revision + 1;
        list.push({ revision: next, body: other.replace(/"revision":\d+,/, `"revision":${next},`), operationId: randomUUID() });
        this.history.set(key, list);
      }
      const op = this.operations.get(r.operationId as string);
      if (!op) return ok(404, { status: "unknown_preview" });
      if (op.owner !== owner) return ok(403, { status: "wrong_owner" });
      if (op.namespace !== namespace || op.environment !== environment || op.expectedRevision !== r.expectedRevision) {
        return ok(409, { status: "preview_mismatch" });
      }
      if (op.hash !== r.previewHash) return ok(409, { status: "hash_mismatch" });
      if (op.body !== r.body) return ok(409, { status: "body_mismatch" });
      if (this.lieApplied) {
        return ok(200, { status: "applied", verified: true, replay: false, operationId: op.id, revision: op.expectedRevision + 1, body: op.body });
      }
      if (op.status === "applied") {
        return this.reply({ status: "applied", verified: true, replay: true, operationId: op.id, revision: op.appliedRevision, body: op.body });
      }
      if (op.status !== "previewed") return ok(409, { status: op.status });
      const now = this.history.get(key) ?? [];
      const nowRevision = now.at(-1)?.revision ?? 0;
      if (nowRevision !== op.expectedRevision) {
        op.status = "stale";
        return ok(409, { status: "stale", currentRevision: nowRevision });
      }
      if (namespace === "sales" && salesActivates(op.body) && !this.cutoff) return ok(409, { status: "cutoff_required" });
      now.push({ revision: op.expectedRevision + 1, body: op.body, operationId: op.id });
      this.history.set(key, now);
      op.status = "applied";
      op.appliedRevision = op.expectedRevision + 1;
      return this.reply({ status: "applied", verified: true, replay: false, operationId: op.id, revision: op.appliedRevision, body: op.body });
    }
    return ok(400, { error: "request-shape" });
  }

  private reply(verified: Record<string, unknown>): HttpResult {
    if (this.afterCommit && this.afterCommitTimes > 0) {
      this.afterCommitTimes--;
      if (this.afterCommit === "checking") return ok(202, { status: "checking", operationId: verified.operationId, revision: verified.revision });
      if (this.afterCommit === "drop") return ok(0, null);
      return ok(500, { error: "internal" });
    }
    return ok(200, verified);
  }

  /** How many apply-type writes landed, across every namespace. */
  get writes(): number {
    return [...this.history.values()].reduce((n, list) => n + list.length, 0);
  }
}

export const allSurfaces = (value: boolean) => Object.fromEntries(PRODUCT_POLICY_SURFACES.map((s) => [s, value]));
export const salesChannels = (enabled: boolean) => ({
  apple: { enabled, offer: "still-pro-v3" },
  web: { enabled, offer: "still-pro-v3" },
});
