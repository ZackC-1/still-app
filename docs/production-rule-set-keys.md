# Production rule-set signing and publication

Current reference reviewed September 14, 2026. Signed rule updates are data, not executable code.
The [earlier guide](archive/pre-2.0-reference-refresh/docs/production-rule-set-keys.md) preserves the
initial publication history. Do not infer current hosted version or private-key custody from it.

## Trust and version selection

`packages/core/src/rules/trusted-keys.ts` contains the production public-key allowlist and rollback
floor. Production builds verify fetched/cached data against production keys; they do not accept a
development-signed remote cache. The packaged seed is a separately trusted offline input, so its
bundled development signature is not evidence that remote production trust was disabled.

Current source seed version is 1.1.9. That is a rule-data version, separate from application 2.0.0.
The initial production migration 0006 contains an older set; applying that migration alone cannot
make an older remote set supersede a newer bundled seed. Clients choose the newest trusted set,
reverify cached data and keep the newer cache against stale fetches. Refresh is shared in flight and
lands for a subsequent content load. A configured endpoint and usable production keys are required;
otherwise blocking continues from the bundle.

## Signing tools

| Command in `@still/core` | Behavior |
|---|---|
| `gen-rule-set-key [kid]` | Creates a keypair, writes a private ignored file and prints only the public key. Refuses to overwrite an existing key. |
| `sign-seed` | Re-signs the bundled seed after a reviewed data change. |
| `sign-prod-set` | Signs seed content with the production key and writes a sequential production migration for the chosen version. |

The production signer reads `STILL_PROD_PRIVATE_KEY_HEX` or the private ignored key file and supports
`STILL_PROD_KID` / `STILL_PROD_VERSION`. Its default version bumps the seed patch. It rejects malformed
or older-than-seed versions and rejects changed content/signatures under an already generated
version. An identical rerun can reuse that version's migration; never rewrite an applied migration
to deliver different rules.

Private-key possession and backup must be verified privately by the operator before signing. Do not
generate a replacement merely because the historical local file is absent; a new key requires the
rotation sequence below. Do not print private keys in commands, transcripts or documentation.

## Future authorized publication

1. Review the rule changes against supported-site behavior and ordinary-content preservation; update
   the bundled seed/version and its tests as applicable.
2. Select a production version newer than both the intended clients' bundle and the current hosted
   version. Generate/review the signed migration using the existing private key.
3. Verify signature, schema and version ordering with the existing tests. Inspect the exact migration
   and deployment target before an authorized database push; do not reapply old migration IDs.
4. Verify the deployed payload and a configured client's adoption. Failure/offline must preserve the
   trusted local fallback. Record versions/hashes and actual observations, not a same-day-delivery promise.

This reference update does not publish a rule set or alter submitted artifacts.

## Rotation

Add the new public key beside the current one, ship clients that trust it, then begin signing with
that key. Retire old keys only after accounting for installed clients and rollback needs. An empty
production key list skips fetching and uses the bundled seed; it must never fall back to dev trust.
