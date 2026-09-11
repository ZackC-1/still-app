# Public contact update

Verified September 11, 2026 (Pacific). The contact source candidate is `d2b95d9`;
subsequent documentation changes do not alter its app payloads.
[PR #169](https://github.com/ZackC-1/still-app/pull/169) records integration into main.
Website publishing remains a separate gh-pages change.

## Addresses and publication

Support and purchase recovery use `support@stillapp.fit`, privacy requests use
`privacy@stillapp.fit`, and general enquiries use `hello@stillapp.fit`.
The owner configured the three aliases and a catch-all in Namecheap. Actual forwarding delivery
still needs a message sent from a different account and receipt confirmation.

The shared app constant, homepage, support, privacy, setup and Terms contacts are updated.
The previously branch-only Terms page is now tracked at `docs/terms.html`; its policy text was
preserved. Store tracks and submission-copy references link the
[public contact checklist](public-contact-addresses.md). Live store metadata and outgoing SMTP
settings have not been changed. Private review accounts and the Firefox application ID are preserved.

## Verification and artifacts

Lint, type checking, 788 unit tests, production web builds, 51 browser fixtures with two
configured-only skips, and all 53 fixtures with configured-account checks passed.
Both iOS and macOS Release archives and App Store exports succeeded. Nested distribution
signatures are valid, debugging is disabled, and macOS sandbox entitlements remain enabled.
All 11 expected web JS/CSS resource hashes match in both Apple packages; the old contact address
is absent from their contents.

Use `docs/build/release-gates/artifacts/contacts-d2b95d9/` for the prepared packages and SHA-256
manifest. iOS/macOS remain version 2.0.0, build 7; browser packages remain 2.0.0. No upload occurred.
Verify current portal build availability before uploading; repeated labels do not identify a package.

The Chrome and Firefox payloads are byte-identical to the preceding 80b4ec6 packages because the
support constant is eliminated with dormant purchase UI. The complete AMO source ZIP includes
the updated source, frozen lockfile and whitelisted public build configuration; a clean extraction
reproduced all 20 Firefox files byte-for-byte. Fresh Apple exports reflect the current source and
build location; Safari/WebView CSS scope hashes can vary by checkout path.

## Backend and remaining release gates

Separately, the owner applied migration 0013 and deployed the five reviewed Edge Functions on
September 11. Live checks confirmed the migration function bodies, constraints, triggers and
restrictive grants, with successful minute cleanup runs and no overdue windows. Migration history
was repaired to applied; the CLI dry run reports the remote database up to date. All five functions
are active and their downloaded application source matches main. This supersedes the pending
deployment inventory in the September 10 reconciliation record.

Public release still requires provider/privacy verification, final device/account journeys, current
store metadata review and submission approval. Forwarding receipt tests and authenticated live
backend journeys have not been inferred from deployment success. The prior release matrix retains
its original candidate attribution; new packages do not automatically inherit physical-device passes.
