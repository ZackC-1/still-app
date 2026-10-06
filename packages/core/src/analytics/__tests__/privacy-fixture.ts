import type { AnalyticsPermission, AnalyticsPrivacyPolicy } from "../consent.js";
import type { SubjectDeps } from "../extension-host.js";
// Synthetic test evidence only; this is never exported from the app or read by production hosts.
export const TEST_PERMISSION: AnalyticsPermission = {
  schemaVersion: 1,
  state: "granted",
  version: "a".repeat(64),
  origin: "99999999-9999-4999-8999-999999999999",
  generation: 1,
  provider: {
    anonymousId: "22222222-2222-4222-8222-222222222222",
    deviceId: "11111111-1111-4111-8111-111111111111",
  },
  purposes: { usage: true, email: true, ai: true },
};
export const TEST_PRIVACY_POLICY: AnalyticsPrivacyPolicy = {
  permissionVersion: TEST_PERMISSION.version,
  context: "ordinary",
  capabilities: {
    device_slice_erasure: {
      status: "verified",
      evidenceRevision: "b".repeat(64),
    },
    account_scope_erasure: {
      status: "verified",
      evidenceRevision: "b".repeat(64),
    },
    identifiable_retention: {
      status: "verified",
      evidenceRevision: "b".repeat(64),
    },
    derived_output_erasure: {
      status: "verified",
      evidenceRevision: "b".repeat(64),
    },
    late_ingestion_fence: {
      status: "verified",
      evidenceRevision: "b".repeat(64),
    },
    test_exclusion: { status: "verified", evidenceRevision: "b".repeat(64) },
  },
};
export const TEST_PRIVACY = {
  permission: async () => TEST_PERMISSION,
  privacyPolicy: TEST_PRIVACY_POLICY,
  envelope: { build_channel: "test" as const },
};

/** Synthetic per-device subject for an account: a fixed id that is never the account id. */
export function testSubjectFor(account: string): string {
  return `5ab5ec7a${account.slice(8)}`;
}
/** A synthetic subject server: every account gets its testSubjectFor id. */
export const TEST_SUBJECTS: SubjectDeps = {
  issue: async (_body, _signal, account) => ({ state: "active", subject: testSubjectFor(account) }),
  onStopped: async () => {},
};
