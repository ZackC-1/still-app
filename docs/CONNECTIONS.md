# Still — services, configuration and operations

Current reference for 2.0.0; reviewed September 14, 2026. This is the connection map for the existing
application, not a new-project setup checklist. Dated verification lives in the
[release record](release/history/2026-09-14-release-status.md). Recheck external state before changing it.
The [initial connection checklist](archive/pre-2.0-reference-refresh/docs/CONNECTIONS.md) is preserved.

## Services and responsibilities

| Service | Current role | Configuration boundary |
|---|---|---|
| GitHub | Source, protected PR workflow and CI; separate `gh-pages` website | Existing repository/account; no new repository needed. |
| Supabase | Email-code auth, optional free settings sync, signed rule hosting, account export/deletion, retained entitlements and security counters | Public client URL/key; private function/database credentials remain server-side. |
| Resend | Supabase custom SMTP for six-digit sign-in emails | Verified `stillapp.fit` sending domain and domain-scoped SMTP key; actual values stay private. |
| Namecheap / Google Workspace | Domain DNS and public contact delivery to the owner's work inbox | Public aliases in [contact guide](release/public-contact-addresses.md); forwarding and sending are separate. |
| RevenueCat / Apple | Retained purchase identities, receipts, entitlements and webhook | Existing app/product IDs; paid access flags remain false. |
| App Store Connect | Separate iOS/macOS submissions carrying Safari extensions | Existing app, signing identities and private reviewer access. |
| Chrome Web Store / Firefox AMO | Desktop extension distribution | Existing listings; Firefox requires complete reproducible sources paired to the uploaded artifact. |
| PostHog | Product analytics under [ADR 0004](adr/0004-first-party-usage-analytics.md): events from every surface, account email attached server-side, deletion with the account | Public project key per build; server-only personal key for deletion. See the [analytics runbook](release/posthog-analytics.md). |

Still's runtime does not use Mem0. Mem0 is shared developer memory under
[docs/MEMORY.md](MEMORY.md), separate from user accounts and the application backend.
No Sentry integration is established merely because an example variable exists.

## Local toolchain and build inputs

Follow the [root development guide](../README.md#development), root `package.json` and frozen lockfile.
Current Node engines are `^22.22.2 || ^24.15.0 || >=26.0.0`; the package-manager pin is pnpm 11.9.0.
Supabase CLI/Docker support local database work; Apple builds require macOS/Xcode.

| Input | Consumer |
|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Package-local build configuration for Chromium/Firefox auth+sync and signed rule fetch, Safari rule fetch, Apple webview auth+sync. |
| `VITE_REVIEW_SIGNIN_EMAIL` | Apple app-webview store build only; must match the private deployed reviewer configuration. Never put it in browser-extension builds. |
| `REVENUECAT_PUBLIC_API_KEY` | Native Apple SDK through local xcconfig / `RevenueCatPublicAPIKey`. |
| `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST` | Package-local build configuration for ext-chromium, ext-safari and app-webview analytics. Blank → no analytics and no "Share usage data" switch. |
| Production rule public-key allowlist | `packages/core/src/rules/trusted-keys.ts`; see [signing guide](production-rule-set-keys.md). |

Blank public configuration keeps blocking local with the bundled seed and disables the associated
cloud capability. It does not introduce a paywall or restrict free blocking to YouTube. An optional
sync release must contain the intended public configuration; synthetic CI values are not production.
Build-time values cannot update an already exported package.

The root and package `.env.example` files enumerate inputs; some comments preserve older purchase-era
terminology. Use this guide for current behavior. Never copy an ignored `.env` wholesale into a
public source archive: include only an explicit allowlist of public build values.

## Server secrets

The configured function dependencies use `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `ENTITLEMENT_WRITER_DB_URL`,
`REVENUECAT_SECRET_API_KEY`, `REVENUECAT_WEBHOOK_TOKEN`, review-sign-in secrets, selector-canary
secrets and the PostHog function secrets (`POSTHOG_PROJECT_KEY`, `POSTHOG_HOST`,
`POSTHOG_API_HOST`, `POSTHOG_PROJECT_ID`, `POSTHOG_PERSONAL_API_KEY`) as applicable. The retained checkout uses `REVENUECAT_WEB_BILLING_CHECKOUT_URL`.
`REVENUECAT_WEB_PRODUCT_ID` is not a current runtime input.

Keep elevated keys, database credentials, review codes and signing private keys outside tracked
files and client bundles. Use private env files/secret management rather than inline CLI values.
The webhook compares the complete Authorization header with its configured token; do not add an
unconfigured prefix. Follow the [RevenueCat](release/04-revenuecat.md) and
[auth deployment](release/extension-purchase-deploy-checklist.md) references.

## Operational evidence and remaining work

The September 14 record credits verified SMTP delivery from the new domain, successful forwarding
for all three aliases, RevenueCat credential/webhook review, migration 0013 and Edge deployments,
and the published current-practice retention policy. Do not repeat setup or reset credentials based
on an old unchecked box. It also records daily backups, no PITR/log drains, and owner-selected manual
monitoring. Provider allowances and retention are external state; inspect before scaling or changes.

The selector canary is a scheduled backend diagnostic, not user browsing telemetry. Invocations
require `SELECTOR_CANARY_INVOCATION_TOKEN`; outbound alerts use `SELECTOR_CANARY_NOTIFY_URL` when
configured. A function existing in source does not prove its current schedule or delivery channel.
Login-walled results can be indeterminate. Diagnose with the current operational evidence before
changing schedules or sending notifications.

Use [counter retention](release/counter-retention.md) for migration/dependency commands and recovery.
Do not remove the documented legacy `--import-map` argument merely to silence the CLI warning.
The hosted disposable-account lifecycle remains the separate certification item in issue #153.

## Git and release controls

`main` is protected through repository ruleset `protect-main`, requiring a PR, resolved review
threads, an up-to-date branch and three CI checks: `lint · typecheck · unit · build`,
`Supabase Edge Functions (Deno)` and `Playwright on fixtures`. The ruleset also blocks force pushes
and branch deletion; its required approval count is zero for the solo-maintainer workflow.
Legacy branch-protection API 404 is not proof that this ruleset is absent.

Current CI runs fixture tests for both unconfigured and synthetic-configured bundles. It does not
certify production credentials, native devices or public store availability. Keep the exact submitted
artifact source/configuration separate from later documentation and dependency commits. Owner portal
copy and builds already in review must be preserved while waiting for release.
