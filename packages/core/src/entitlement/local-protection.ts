import { FEATURE_IDS, TIKTOK_ALIAS, type LocalProtectionRecord, type ProtectedBenefitSnapshot } from "@still/shared-types";
import { isSafeAccessInteger } from "./access-proof.js";

const benefits = new Set<string>([...FEATURE_IDS, TIKTOK_ALIAS.id]);
const versionPattern = /^\d{1,9}(?:\.\d{1,9}){0,3}$/;
const productPattern = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const cutoffs = new WeakSet<object>();
export interface LocalProtectionCutoff extends ProtectedBenefitSnapshot { readonly activatedAt: number }

/** Internal packaged/authenticated CP109 policy only. Never expose caller-chosen policy on a
 * runtime route. The production cutoff does not exist in this source slice. */
export function localProtectionCutoff(snapshot: ProtectedBenefitSnapshot, activatedAt: number): LocalProtectionCutoff {
  if (!isSafeAccessInteger(activatedAt) || activatedAt === 0 || !validSnapshot(snapshot)) throw new Error("Invalid protection policy");
  const result = Object.freeze({ product: snapshot.product, benefits: Object.freeze([...snapshot.benefits]), activatedAt });
  cutoffs.add(result);
  return result;
}
function validSnapshot(value: ProtectedBenefitSnapshot): boolean {
  return typeof value.product === "string" && productPattern.test(value.product) && value.product !== "still-pro-v3" &&
    Array.isArray(value.benefits) && value.benefits.length > 0 && value.benefits.length <= 32 &&
    value.benefits.every((b, i, all) => benefits.has(b) && (i === 0 || all[i - 1]! < b));
}
function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(d => !Object.hasOwn(d, "value"))) return null;
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
export type OriginalProtectionEvidence =
  | { readonly status: "absent" | "unreadable" | "unsupported" }
  | { readonly status: "legacy"; readonly firstRecordedAt: number; readonly firstRecordedAppVersion: string };

/** Assess, never rewrite, the actual retained local fields. Local history is intentionally not
 * cryptographic evidence and can never establish a purchased or original-payer entitlement. */
export function assessOriginalProtection(value: unknown): OriginalProtectionEvidence {
  if (value === undefined || value === null) return { status: "absent" };
  try {
    const raw = object(value);
    if (!raw) return { status: "unreadable" };
    const schema = Object.hasOwn(raw, "schemaVersion") ? raw.schemaVersion : 1;
    if (!isSafeAccessInteger(schema) || schema === 0) return { status: "unreadable" };
    if (schema !== 1) return { status: "unsupported" };
    if (!isSafeAccessInteger(raw.firstRecordedAt) || raw.firstRecordedAt === 0 ||
        typeof raw.firstRecordedAppVersion !== "string" || !versionPattern.test(raw.firstRecordedAppVersion)) return { status: "unreadable" };
    return { status: "legacy", firstRecordedAt: raw.firstRecordedAt, firstRecordedAppVersion: raw.firstRecordedAppVersion };
  } catch { return { status: "unreadable" }; }
}

export function parseLocalProtection(value: unknown): LocalProtectionRecord | null {
  if (value === undefined || value === null) return null;
  try {
    const raw = object(value);
    if (!raw || !exact(raw, ["schema", "provenance", "original", "grant"]) || raw.schema !== 1) throw new Error();
    if (raw.provenance === "accepted_legacy_local") {
      const original = object(raw.original);
      if (!original || !exact(original, ["firstRecordedAt", "firstRecordedAppVersion"]) || assessOriginalProtection(original).status !== "legacy") throw new Error();
    } else if (raw.provenance !== "free_self_declaration" || raw.original !== null) throw new Error();
    if (raw.grant !== null) {
      const grant = object(raw.grant);
      if (!grant || !exact(grant, ["product", "benefits", "activatedAt"]) || !isSafeAccessInteger(grant.activatedAt) || grant.activatedAt === 0 ||
          !validSnapshot(grant as unknown as ProtectedBenefitSnapshot) ||
          (raw.provenance === "accepted_legacy_local" && (raw.original as { firstRecordedAt: number }).firstRecordedAt >= grant.activatedAt)) throw new Error();
    }
    return raw as unknown as LocalProtectionRecord;
  } catch { throw new Error("Unreadable local protection"); }
}

export type LocalProtectionMutation =
  | { readonly kind: "assess-original"; readonly original: unknown; readonly cutoff: LocalProtectionCutoff | null }
  | { readonly kind: "declare"; readonly confirmed: true; readonly priorEvidence: "absent"; readonly cutoff: LocalProtectionCutoff | null }
  | { readonly kind: "apply-cutoff"; readonly cutoff: LocalProtectionCutoff };

/** Runs only inside the existing entitlement writer. No account/clock/expiry is stored here. */
export function mutateLocalProtection(current: LocalProtectionRecord | null, mutation: LocalProtectionMutation): LocalProtectionRecord | null {
  current = parseLocalProtection(current);
  if (mutation.cutoff !== null && !cutoffs.has(mutation.cutoff)) throw new Error("Untrusted protection policy");
  if (mutation.kind === "declare" && (mutation.confirmed !== true || mutation.priorEvidence !== "absent")) throw new Error("Explicit recovery confirmation required");
  if (current?.grant) return current; // Accepted standalone rights never depend on later policy availability.
  let next = current;
  if (mutation.kind === "assess-original" && !next) {
    const original = assessOriginalProtection(mutation.original);
    if (original.status !== "legacy") return null;
    next = { schema: 1, provenance: "accepted_legacy_local", original: { firstRecordedAt: original.firstRecordedAt, firstRecordedAppVersion: original.firstRecordedAppVersion }, grant: null };
  } else if (mutation.kind === "declare") {
    // This never rewrites or backdates the retained original installation record.
    next = { schema: 1, provenance: "free_self_declaration", original: null, grant: null };
  }
  if (!next || !mutation.cutoff) return next;
  if (next.provenance === "accepted_legacy_local" && next.original!.firstRecordedAt >= mutation.cutoff.activatedAt) return next;
  return { ...next, grant: { product: mutation.cutoff.product, benefits: [...mutation.cutoff.benefits], activatedAt: mutation.cutoff.activatedAt } };
}
