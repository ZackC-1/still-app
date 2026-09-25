# Still 2.0.0 reference audit — September 14, 2026

Scope: the 147 tracked Markdown documents at `4877e2e`, following merged organization PR #197.
The owner asked that reference material reflect the free release and all completed changes.
This is a documentation audit, not a new application build, provider check or store submission.

## Coverage

The inventory classifies 46 current reference/governance documents, 25 reusable learnings, four
ADR/index documents, 48 plans/history files, nine dated evidence/proposal files and 15 historical/
research files. Scans covered version, pricing, account, platform, configuration, privacy and release
claims; current guidance was reconciled with source and the later owner-approved release record.

| Area | Authoritative references and correction |
|---|---|
| Product | [PRODUCT.md](../../PRODUCT.md), [strategy](../../../STRATEGY.md), [changelog](../../../CHANGELOG.md): all four services free, optional free sync, current platforms, controls and limitations. |
| Architecture / vocabulary | [Architecture](../../ARCHITECTURE.md), [concepts](../../../CONCEPTS.md), [ADR 0003](../../adr/0003-entitlement-authority-receipt-and-server.md): server-row reconciliation, lifecycle guards, local sign-out, retained receipt/server authority. |
| Configuration | [Connections](../../CONNECTIONS.md), [signing](../../production-rule-set-keys.md), [Apple helpers](../../../apps/apple/scripts/README.md): actual toolchain/configuration and source-build versus submitted-build provenance. |
| Stores | [Apple](../01-apple-app-store.md), [Chrome](../02-chrome-web-store.md), [Firefox](../03-firefox-amo.md), [mobile](../06-mobile-blocking-validation.md): free reviewer flows and current evidence boundaries; original procedures archived. |
| Monetization / auth | [Monetization](../../monetization-design.md), [RevenueCat](../04-revenuecat.md), [auth/reviewer configuration](../extension-purchase-deploy-checklist.md): dormant purchases, active identities, current email-code flow. |
| Privacy / support | [Counter retention](../counter-retention.md), [contacts](../public-contact-addresses.md), [historical privacy proposal](../privacy-retention-draft.md): completed deployment, forwarding and published current-practice policy distinguished from future checks. |
| Marketing | [Playbook](../marketing-playbook.md), [content pack](../launch-content-pack.md), [listing drafts](../store-listing-copy.md), [screenshots](../screenshots/store-ready/README.md): free functionality and owner-approved homepage/portal decisions. |
| Evidence / history | [Release status](2026-09-14-release-status.md), [validation](../VALIDATION.md), dated candidates and [archives](../../archive/README.md): preserve hashes/results and point older pending observations to later evidence. |

The original v1 specification is explicitly historical; current development starts from PRODUCT.md.
Nine superseded reference originals are preserved in the
[reference snapshot archive](../../archive/pre-2.0-reference-refresh/README.md). No information is
removed to make a reference appear current. Plans/research/ADRs retain their decision context;
old paid-mode solution examples are qualified where they could be mistaken for current requirements.

## Evidence checked against source

- Both paid-tier constants remain false; free sync migration 0012 remains in the schema history.
- The shared sync service uses account identity, server-row anchors, lifecycle isolation, held
  writes and recovery; it is more precise than simple device-clock last-write-wins.
- Chromium/Firefox manifest scope, Firefox desktop minimum/consent, and actual package scripts
  match the current guides. Node/pnpm requirements come from the root package manifest.
- Xcode source defaults are 2.0.0 (7), with iOS/iPadOS 15.0 and macOS 12.0 deployment targets.
  The submitted Apple 2.0.0 (8) packages retain their separately recorded provenance.
- Source seed version 1.1.9, production trust selection and signing-script migration guards match
  the updated rule publication guide. No private key was read or generated.
- Provider/email/privacy/store observations remain attributed to the September 14 record and
  the owner's confirmations. No new live-portal verification is claimed.

## Verification and limits

The local preservation check confirms all 403 non-Markdown baseline files are byte-identical.
Nine archived originals retain their full text except the explicit historical header and rebased
relative document URLs. Local Markdown paths/anchors and package command names are checked against
the current tree, with pre-existing historical link debt distinguished from new errors.
Required CI and merge evidence belong to the PR linked from the
[implementation plan](../../plans/2026-09-14-still-2-reference-audit.md).

The ignored `docs/build/2.0-release-evidence/implementation/reference-audit-20260914/` holds the per-file
inventory and verification receipts. Current reference corrections do not turn old test rows into
passes: existing Mac/iPhone evidence stays credited, physical iPad remains owner-accepted
skipped/unverified, and issue #153 retains hosted account-lifecycle/final-certification work.
The owner is waiting for store rollout before broad promotion. Website source, published pages,
store metadata, screenshots and submitted packages were not changed by this audit.
