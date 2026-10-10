import { isAnalyticsId, type AnalyticsKeyValue } from "./identity.js";
import { deriveAnonymousId, deriveDeviceId } from "./derive.js";
import { USAGE_ON_BY_DEFAULT_BUILD } from "./build-basis.js";

// One device-local permission authority. Old On and native/store permission never imply that
// the approved current usage/email/AI purposes and recipients have been accepted.

export const CONSENT_KEY = "still:analytics:enabled";
export const PRIVACY_CAPABILITIES = [
  "device_slice_erasure",
  "account_scope_erasure",
  "identifiable_retention",
  "derived_output_erasure",
  "late_ingestion_fence",
  "test_exclusion",
] as const;
export interface AnalyticsPermission {
  readonly schemaVersion: 1;
  readonly state: "granted" | "stopped";
  /** Digest of the actual approved purpose/recipient disclosure; no fabricated release default. */
  readonly version: string;
  readonly origin: string;
  readonly generation: number;
  /** Optional provider identities belong only to this consent origin, never the functional install. */
  readonly provider: {
    readonly anonymousId: string;
    readonly deviceId: string;
  };
  readonly purposes: {
    readonly usage: true;
    readonly email: true;
    readonly ai: true;
  };
}
export interface AnalyticsPrivacyPolicy {
  /** "adr-0004": usage sharing on by default with a per-device off switch (default-on.ts). Accepted
   * only in builds compiled with that basis (build-basis.ts); there it needs no capability evidence,
   * because ADR 0004's disclosure promises none. Absent: the capability-evidence gate below. */
  readonly basis?: "adr-0004";
  readonly permissionVersion: string;
  readonly context: "ordinary" | "private" | "unknown";
  readonly capabilities: Partial<
    Record<
      (typeof PRIVACY_CAPABILITIES)[number],
      { readonly status: "verified"; readonly evidenceRevision: string } | { readonly status: "unavailable" }
    >
  >;
}
const REVISION = /^[a-f0-9]{64}$/;
export function readAnalyticsPermission(value: unknown): AnalyticsPermission | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 7 ||
    v.schemaVersion !== 1 ||
    (v.state !== "granted" && v.state !== "stopped") ||
    typeof v.version !== "string" ||
    !REVISION.test(v.version) ||
    !isAnalyticsId(v.origin) ||
    !Number.isSafeInteger(v.generation) ||
    (v.generation as number) < 1
  )
    return null;
  const provider = v.provider as Record<string, unknown> | undefined;
  if (
    !provider ||
    typeof provider !== "object" ||
    Array.isArray(provider) ||
    Object.keys(provider).length !== 2 ||
    !isAnalyticsId(provider.anonymousId) ||
    !isAnalyticsId(provider.deviceId) ||
    provider.anonymousId === provider.deviceId
  )
    return null;
  const p = v.purposes;
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).length !== 3) return null;
  const purposes = p as Record<string, unknown>;
  if (purposes.usage !== true || purposes.email !== true || purposes.ai !== true) return null;
  return {
    schemaVersion: 1,
    state: v.state,
    version: v.version,
    origin: v.origin as string,
    generation: v.generation as number,
    provider: {
      anonymousId: provider.anonymousId,
      deviceId: provider.deviceId,
    },
    purposes: { usage: true, email: true, ai: true },
  };
}
/** Trusted host evidence, never an event/page boolean. Unknown capabilities hold collection. */
export function privacyPolicyReady(policy: AnalyticsPrivacyPolicy | undefined): boolean {
  // Folded away in 2.x builds (build-basis.ts). Elsewhere a host passes this basis only from its V3
  // branch; the permission version must still match the stored permission exactly.
  if (USAGE_ON_BY_DEFAULT_BUILD && policy?.basis === "adr-0004")
    return policy.context === "ordinary" && REVISION.test(policy.permissionVersion);
  return (
    policy?.context === "ordinary" &&
    typeof policy.permissionVersion === "string" &&
    REVISION.test(policy.permissionVersion) &&
    PRIVACY_CAPABILITIES.every((name) => {
      const capability = policy.capabilities?.[name];
      return (
        capability?.status === "verified" &&
        typeof capability.evidenceRevision === "string" &&
        REVISION.test(capability.evidenceRevision)
      );
    })
  );
}
export function samePermission(a: AnalyticsPermission | null, b: AnalyticsPermission | null): boolean {
  return (
    !!a &&
    !!b &&
    a.state === "granted" &&
    b.state === "granted" &&
    a.origin === b.origin &&
    a.generation === b.generation &&
    a.version === b.version &&
    a.provider.anonymousId === b.provider.anonymousId &&
    a.provider.deviceId === b.provider.deviceId
  );
}

export interface AnalyticsConsent {
  get(): Promise<boolean>;
  read(): Promise<AnalyticsPermission | null>;
  set(enabled: boolean): Promise<void>;
  /** Called only after the actual approved combined-consent choice. */
  grant(permissionVersion: string): Promise<void>;
}

export interface StoredConsentOptions {
  /**
   * Whether the device-erasure service durably owns the cleanup of a stopped origin (its ledger
   * entry is recorded). Only then may a fresh Share start a new origin while that cleanup is still
   * running at the provider; the new origin derives new ids, so nothing is ever reused. Without it a
   * stopped record keeps refusing a new grant, as before.
   */
  readonly cleanupOwned?: (origin: string) => Promise<boolean>;
}

export function createStoredConsent(
  store: AnalyticsKeyValue,
  _legacyDefaultOn: boolean,
  options: StoredConsentOptions = {},
): AnalyticsConsent {
  let stopped = false;
  let revision = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const run = (op: () => Promise<void>) => {
    const next = chain.then(op, op);
    chain = next.catch(() => undefined);
    return next;
  };
  const read = async () => {
    if (stopped) return null;
    try {
      return readAnalyticsPermission(await store.get(CONSENT_KEY));
    } catch {
      return null;
    }
  };
  return {
    read,
    async get() {
      return (await read())?.state === "granted";
    },
    set(enabled) {
      if (enabled) return Promise.reject(new Error("Fresh combined permission is required"));
      stopped = true;
      revision += 1;
      return run(async () => {
        const old = readAnalyticsPermission(await store.get(CONSENT_KEY));
        // Keep minimal stopped-origin authority; provider deletion completion is a later gate.
        await store.set(
          CONSENT_KEY,
          old
            ? {
                ...old,
                state: "stopped",
                generation: Math.min(Number.MAX_SAFE_INTEGER, old.generation + 1),
              }
            : false,
        );
      });
    },
    grant(version) {
      if (!REVISION.test(version)) return Promise.reject(new Error("Approved permission revision is required"));
      const asked = ++revision;
      return run(async () => {
        const old = readAnalyticsPermission(await store.get(CONSENT_KEY));
        if (asked !== revision) return;
        // Provider acceptance is not completed scoped erasure. A stopped origin stays a tombstone
        // until the deletion service durably owns its cleanup; no identity revival here.
        if (old?.state === "stopped" && !(await options.cleanupOwned?.(old.origin).catch(() => false))) {
          throw new Error("Previous permission cleanup is pending");
        }
        if (asked !== revision) return;
        if (old?.state === "granted" && old.version === version) return;
        const generation = (old?.generation ?? 0) + 1;
        if (!Number.isSafeInteger(generation)) throw new Error("Permission generation exhausted");
        // A new private origin per lifecycle; both provider ids are derived from it (derive.ts), so
        // the device can later name every id it sent without keeping a list.
        const origin = crypto.randomUUID();
        const [anonymousId, deviceId] = await Promise.all([deriveAnonymousId(origin, 0), deriveDeviceId(origin)]);
        if (asked !== revision) return;
        await store.set(CONSENT_KEY, {
          schemaVersion: 1,
          state: "granted",
          version,
          origin,
          generation,
          provider: { anonymousId, deviceId },
          purposes: { usage: true, email: true, ai: true },
        });
        if (asked === revision) stopped = false;
      });
    },
  };
}
