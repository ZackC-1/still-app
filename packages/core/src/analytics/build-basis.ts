// Which consent basis this build compiles in. Read by `privacyPolicyReady` (consent.ts) only.
//
// V3 builds (browser modern settings, or the Apple atomic settings screens) share usage data on by
// default with a per-device off switch, as ADR 0004 decided and the owner reaffirmed for V3 on
// 2026-10-10. The hosts opt in by passing DEFAULT_ON_USAGE_POLICY (default-on.ts) from their own
// V3-only branches.
//
// This is a build-time constant on purpose, and the one place core reads build values: Vite inlines
// both flags, so in every 2.x build (both unset) this is `false` and the default-on branch in
// `privacyPolicyReady` folds away, leaving the shipped 2.x bundles byte-for-byte as they were
// (docs/solutions/conventions/add-paid-only-code-without-changing-shipped-bundles.md). Tests that
// exercise the default-on basis mock this module.
//
// The cast keeps core free of Vite's ambient types; after type stripping it is the plain
// `import.meta.env.NAME` expression Vite replaces.
export const USAGE_ON_BY_DEFAULT_BUILD: boolean =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_MODERN_SETTINGS_SYNC_ENABLED ===
    "true" ||
  (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_APPLE_ATOMIC_SETTINGS === "true";
