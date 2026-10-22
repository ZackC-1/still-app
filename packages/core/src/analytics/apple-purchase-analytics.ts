import type { NativeProResult } from "../native/bridge.js";
import type {
  AnalyticsClient,
  AnalyticsObservation,
  AppleAnalyticsIdentityScope,
} from "./client.js";
import type { AnalyticsKeyValue } from "./identity.js";
import { originProof } from "./derive.js";
import { readAppleCanonicalReceipt } from "./apple-canonical-receipt.js";

const KEY = "still:analytics:apple-purchase";
const hex = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export interface ApplePurchaseAnalyticsContext {
  readonly client: AnalyticsClient;
  readonly observation: AnalyticsObservation;
  readonly scope: AppleAnalyticsIdentityScope;
  readonly surface: "app-ios" | "app-macos";
  readonly appVersion: string;
}
export type ApplePurchaseAnalyticsRequest = (
  body: Record<string, unknown>,
  account: string | null,
  signal: AbortSignal,
  current: () => Promise<boolean>,
) => Promise<unknown>;
export interface ApplePurchaseAnalytics {
  begin(): Promise<((result: NativeProResult) => void) | null>;
  observe(): Promise<void>;
  clear(): void;
}
interface Retained {
  capability: string;
  originProof: string;
  scope: AppleAnalyticsIdentityScope;
  delivered: string[];
  retainUntil: number;
}
function retained(value: unknown): Retained | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Retained;
  if (
    !Number.isSafeInteger(v.retainUntil) ||
    !hex(v.capability) ||
    !hex(v.originProof) ||
    !v.scope ||
    typeof v.scope !== "object" ||
    !Number.isSafeInteger(v.scope.accountGeneration) ||
    !Array.isArray(v.delivered) ||
    v.delivered.length > 2 ||
    !v.delivered.every((x) => typeof x === "string" && x.length === 36)
  )
    return null;
  return v;
}
/** The capability is local to one original consent/identity scope. It is never synced or used
 * as an entitlement. Only ordinary app foregrounds retry canonical results, never background jobs. */
export function createApplePurchaseAnalytics(deps: {
  context(): Promise<ApplePurchaseAnalyticsContext | null>;
  store: AnalyticsKeyValue;
  projectKey: string;
  request: ApplePurchaseAnalyticsRequest;
}): ApplePurchaseAnalytics {
  let generation = 0;
  let active = false;
  let storageChain: Promise<unknown> = Promise.resolve();
  const write = (value: Retained | null) => {
    const pending = storageChain.then(() => deps.store.set(KEY, value));
    storageChain = pending.catch(() => undefined);
    return pending;
  };
  const project = crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(deps.projectKey.trim()))
    .then((value) =>
      [...new Uint8Array(value)]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join(""),
    );
  const current = async (c: ApplePurchaseAnalyticsContext, g: number) =>
    generation === g &&
    (await c.client.observationCurrent(c.observation)) &&
    generation === g &&
    JSON.stringify(await c.client.applePurchaseScope(c.observation)) ===
      JSON.stringify(c.scope);
  const scopeBody = (s: AppleAnalyticsIdentityScope) =>
    s.subject === null
      ? { kind: "anonymous", anonIndex: s.anonIndex }
      : { kind: "subject" };
  async function request(
    c: ApplePurchaseAnalyticsContext,
    g: number,
    body: Record<string, unknown>,
    ms: number,
  ): Promise<unknown> {
    const abort = new AbortController();
    const scopeSignal = c.client.cancellationSignal();
    const cancel = () => abort.abort();
    scopeSignal.addEventListener("abort", cancel, { once: true });
    if (scopeSignal.aborted) abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const payload = {
        ...body,
        originProof: await originProof(c.observation.permission.origin),
        projectKeySha256: await project,
        scope: scopeBody(c.scope),
      };
      if (abort.signal.aborted || !(await current(c, g))) return null;
      return await Promise.race([
        deps.request(payload, c.scope.account, abort.signal, () =>
          current(c, g),
        ),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            abort.abort();
            resolve(null);
          }, ms);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      scopeSignal.removeEventListener("abort", cancel);
    }
  }
  async function deliver(
    c: ApplePurchaseAnalyticsContext,
    g: number,
    r: Retained,
    response: unknown,
  ) {
    if (!response || typeof response !== "object" || Array.isArray(response))
      return;
    const v = response as Record<string, unknown>;
    if (
      Object.keys(v).sort().join(",") !== "events,schema,status" ||
      v.schema !== 1 ||
      v.status !== "canonical" ||
      !Array.isArray(v.events) ||
      v.events.length > 2 ||
      !(await current(c, g))
    )
      return;
    const receipts = v.events.map(readAppleCanonicalReceipt);
    if (
      receipts.some((x) => !x) ||
      (receipts.length === 2 &&
        (receipts[0]!.event !== "purchase_recorded" ||
          receipts[1]!.event !== "purchase_refunded"))
    )
      return;
    for (const receipt of receipts) {
      if (!receipt || r.delivered.includes(receipt.uuid)) continue;
      // Each event ages independently: an old undelivered sale must not suppress a fresh,
      // verified refund during the attribution's longer ninety-day lifetime.
      if (Date.parse(receipt.timestamp) < Date.now() - 30 * 86_400_000)
        continue;
      if (
        !(await current(c, g)) ||
        !(await c.client.deliverAppleCanonicalReceipt(
          receipt,
          c.observation,
          r.scope,
        )) ||
        !(await current(c, g))
      )
        return;
      r = { ...r, delivered: [...r.delivered, receipt.uuid].slice(-2) };
      await write(r).catch(() => undefined);
      if (!(await current(c, g))) {
        await write(null).catch(() => undefined);
        return;
      }
    }
  }
  return {
    async begin() {
      const g = generation,
        c = await deps.context();
      if (!c || !(await current(c, g))) return null;
      const reply = await request(
        c,
        g,
        { action: "prepare", surface: c.surface, appVersion: c.appVersion },
        500,
      );
      if (!reply || typeof reply !== "object" || Array.isArray(reply))
        return null;
      const v = reply as Record<string, unknown>;
      if (
        Object.keys(v).sort().join(",") !== "capability,schema,status" ||
        v.schema !== 1 ||
        v.status !== "prepared" ||
        !hex(v.capability) ||
        !(await current(c, g))
      )
        return null;
      const r: Retained = {
        capability: v.capability,
        originProof: await originProof(c.observation.permission.origin),
        scope: c.scope,
        delivered: [],
        retainUntil: Date.now() + 90 * 86_400_000,
      };
      let used = false;
      return (result) => {
        if (used) return;
        used = true;
        if (!result.newPurchaseEvidence || result.outcome !== "purchased")
          return;
        void (async () => {
          if (!(await current(c, g))) return;
          // Retain only after a native actual-purchase completion, never after preparation alone.
          await write(r);
          if (!(await current(c, g))) {
            await write(null);
            return;
          }
          const response = await request(
            c,
            g,
            {
              action: "commit",
              capability: r.capability,
              transaction: result.newPurchaseEvidence,
            },
            8_000,
          );
          await deliver(c, g, r, response);
        })().catch(() => undefined);
      };
    },
    async observe() {
      if (active) return;
      active = true;
      try {
        const g = generation,
          c = await deps.context();
        await storageChain;
        const r = retained(await deps.store.get(KEY));
        if (!r) return;
        if (!c) return;
        if (
          r.retainUntil <= Date.now() ||
          !(await current(c, g)) ||
          r.originProof !==
            (await originProof(c.observation.permission.origin)) ||
          JSON.stringify(r.scope) !== JSON.stringify(c.scope)
        ) {
          await write(null);
          return;
        }
        const response = await request(
          c,
          g,
          { action: "observe", capability: r.capability },
          8_000,
        );
        await deliver(c, g, r, response);
      } catch {
        /* Optional analytics does not hold foreground or purchasing. */
      } finally {
        active = false;
      }
    },
    clear() {
      generation++;
      void write(null).catch(() => undefined);
    },
  };
}
