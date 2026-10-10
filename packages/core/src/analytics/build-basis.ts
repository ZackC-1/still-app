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
// (docs/solutions/conventions/add-paid-only-code-without-changing-shipped-bundles.md). Vitest also
// inlines the flags from the environment the run started with (vi.stubEnv does not change them), so
// tests that exercise the default-on basis mock this module.
//
// Outside Vite and Vitest (plain Node, a bare TypeScript runner) `import.meta.env` does not exist:
// the `typeof` guard makes the module load there and read as a 2.x build instead of throwing. Vite
// still folds the whole expression (checked with the bundle identity snapshots). The casts keep core
// free of Vite's ambient types; after type stripping these are the plain `import.meta.env`
// expressions Vite replaces.
type BuildEnv = { readonly env: Record<string, string | undefined> };
export const USAGE_ON_BY_DEFAULT_BUILD: boolean =
  typeof (import.meta as unknown as Partial<BuildEnv>).env === "object" &&
  ((import.meta as unknown as BuildEnv).env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true" ||
    (import.meta as unknown as BuildEnv).env.VITE_APPLE_ATOMIC_SETTINGS === "true");
