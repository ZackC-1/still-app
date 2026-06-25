# Production rule-set signing keys — deploy runbook

The Safari (and Chromium) extensions verify any fetched rule set against an Ed25519 signing-key
allowlist before applying it (`packages/core/src/rules/`). Until **production** keys are published, a
production build trusts an *empty* allowlist — so it verifies nothing, the runtime fetch returns null,
and the extension keeps applying the **bundled seed**. The dev key is never trusted in a production
build. Runtime rule updates therefore stay off in production until this runbook is completed.

This is a **human deploy action** (the private key must never enter CI or the extension bundle). The
wiring, fetch/verify/cache, and tests already ship (U8); this only adds the keys + the published set.

## What's already wired

- `packages/ext-safari/lib/rule-set.ts` — `ruleSetTrustedKeys(prod)` selects `PRODUCTION_RULE_SET_KEYS`
  on a prod build, `DEV_RULE_SET_KEYS` on a dev build. `refreshRuleSetCache` (background) fetches +
  verifies + caches; `resolveRuleSetForLoad` (content) applies the newest of {cached, bundled}.
- `packages/core/src/rules/trusted-keys.ts` — `PRODUCTION_RULE_SET_KEYS` (empty, awaiting step 2).
- The fetch endpoint comes from `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` at build time; the RPC
  is `get_current_rule_set` (override via `RuleSetEndpoint.rpc`).

## Procedure

### 1. Generate the production Ed25519 keypair (offline, kept secret)

```sh
node -e '
import("@noble/ed25519").then(async (ed) => {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed.getPublicKeyAsync(priv);
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  console.log("PRIVATE (store in a secret manager, NEVER commit):", hex(priv));
  console.log("PUBLIC  (publsh.pub hex → trusted-keys.ts):", hex(pub));
});'
```

Store the **private** key in the secret manager only. Choose a `kid`, e.g. `still-prod-1`.

### 2. Populate `PRODUCTION_RULE_SET_KEYS`

In `packages/core/src/rules/trusted-keys.ts`:

```ts
export const PRODUCTION_RULE_SET_KEYS: readonly TrustedKey[] = [
  { kid: "still-prod-1", publicKeyHex: "<64 hex chars from step 1>" },
  // add the NEXT rotation key here alongside the current one before rotating
];
```

### 3. Sign the production rule set

Mirror `scripts/sign-seed.mjs`, but read the private key + kid from the environment (never a literal):

```sh
STILL_PROD_PRIVATE_KEY_HEX=<secret> STILL_PROD_KID=still-prod-1 node scripts/sign-prod-set.mjs
```

The signed set must be **≥ `RULE_SET_MIN_VERSION`** (rollback floor, currently `1.0.0`) and strictly
newer than the bundled seed for the runtime fetch to adopt it.

### 4. Publish to the `get_current_rule_set` RPC

The hosted Supabase project must serve the current signed set from `get_current_rule_set`
(`rest/v1/rpc/get_current_rule_set`), returning a row `{ payload: { version, services }, signature }`.
If only the dev seed migration exists (`supabase/migrations/0004_seed_rule_set.sql`), add a
production-signed `current` row / migration. **Do not** commit the private key in the migration.

### 5. Verify end-to-end

- A production extension build (`import.meta.env.PROD`) with `VITE_SUPABASE_URL`/`ANON_KEY` set fetches
  the published set, verifies it against `still-prod-1`, caches it, and applies it on the next load.
- Confirm a tampered or below-floor set is rejected (already covered by
  `packages/ext-safari/lib/__tests__/rule-set.test.ts` against a test key).

## Rotation

Add the new key to `PRODUCTION_RULE_SET_KEYS` **alongside** the current one, ship that build, then start
signing with the new key. Remove the retired key only after the old build is no longer in the field.
