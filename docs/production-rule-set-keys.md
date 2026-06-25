# Production rule-set signing keys — deploy runbook

The Safari (and Chromium) extensions verify any fetched rule set against an Ed25519 signing-key
allowlist before applying it (`packages/core/src/rules/`). A **production** build trusts only
`PRODUCTION_RULE_SET_KEYS`; the dev key is never trusted in a prod build. The current set is served
from the hosted `get_current_rule_set()` RPC and applied if it's strictly newer than the bundled seed.

## Status (what's already done)

The production signing key + initial published set are wired up:

- **`PRODUCTION_RULE_SET_KEYS`** (`packages/core/src/rules/trusted-keys.ts`) holds the prod public key
  `still-prod-1`.
- **`supabase/migrations/0006_prod_rule_set.sql`** is the prod-signed current set (v1.0.1), generated
  by the signer. A CI test (`signature.test.ts`) verifies it against the shipped public key, so a
  key/signature mismatch fails the build.
- The **private key** lives only in the gitignored `packages/core/.secrets/rule-set-prod-key.local`
  on the machine that generated it. **Move it into your secret manager and delete that file.**

**Two human deploy actions remain:**

1. Secure the private key (above).
2. Apply the migration to hosted Supabase — `supabase db push` (linked project) **or** paste
   `0006_prod_rule_set.sql` into the Supabase SQL editor. After that, production extensions fetch +
   verify + apply the prod-signed set.

## Scripts

- `pnpm --filter @still/core gen-rule-set-key [kid]` — generate a keypair. Writes the private key to
  the gitignored secrets file, prints **only** the public key (ready to paste into
  `PRODUCTION_RULE_SET_KEYS`). Default kid `still-prod-1`. Refuses to overwrite an existing key file.
- `pnpm --filter @still/core sign-prod-set` — sign `rules/seed.json`'s content with the prod key and
  (re)write `supabase/migrations/0006_prod_rule_set.sql`. Reads the private key from
  `STILL_PROD_PRIVATE_KEY_HEX` or the secrets file. Env overrides: `STILL_PROD_KID`,
  `STILL_PROD_VERSION` (default: the seed version with the patch bumped, so it's strictly newer).

## Publishing a rule-set update later

When you change the rules (edit `packages/core/rules/seed.json` and `pnpm --filter @still/core
sign-seed` to re-sign the bundled seed at a new version):

1. `STILL_PROD_VERSION=<new-version> pnpm --filter @still/core sign-prod-set` (private key in env or
   the secrets file restored from your secret manager) — regenerates the migration at the new version.
2. Commit the regenerated migration, then `supabase db push` (or run the SQL).

Clients adopt the new set on next fetch because it's strictly newer than what they hold (rollback floor
is `RULE_SET_MIN_VERSION`).

## Rotation

Generate a new keypair, **add** its public key to `PRODUCTION_RULE_SET_KEYS` alongside the current one,
ship that build, then start signing with the new key (`STILL_PROD_KID=still-prod-2`). Remove the
retired key only after the old build is out of the field.

## Safety properties

- A prod build trusts **only** `PRODUCTION_RULE_SET_KEYS` — never the dev key — enforced by build mode
  in `packages/ext-safari/lib/rule-set.ts` and asserted in its tests.
- If the prod key list were ever empty, the fetch is skipped and the bundled seed applies (fail-safe).
- The payload + signature are public (served to every client); only the private key is secret.
