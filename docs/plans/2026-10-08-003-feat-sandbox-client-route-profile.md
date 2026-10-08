# Sandbox client route profile and purchase recovery

Status: source and local verification complete; ready for coordinator review/integration.
External peer review, hosted activation and complete QA packages remain pending.

Base: `da022966f405713beeebeb5c0c367bd3b051331b`.
Branch: `feat/v31-sandbox-client-routes-20261008`.

Bind browser clients to one compiled `production` or `shared-hosted-sandbox` route profile.
The profile is separate from access-proof environment and is never selected by a request,
URL, stored setting, or message. Unknown profiles and profile/trust disagreement hold requests.
The QA session spine also requires modern settings sync; its backend rejects legacy settings
table/RPC access and never subscribes to legacy settings realtime.
Existing production defaults, free blocking, and free settings sync retain their behavior.

Use the seven fixed QA endpoints agreed in
the coordinated `2026-10-08-001-feat-shared-hosted-paid-sandbox-qa.md` plan: policy, settings,
reconciliation, Apple verification/link, checkout creation and checkout completion.
Browser purchases persist the server-issued operation with the originating account, survive
worker restart, and complete through authenticated transport before scoped reconciliation.
A checkout response, query parameter, or import acknowledgement never grants Pro.
Creation and completion share one session-fenced queue, so overlapping terminal responses cannot
clear a newer purchase's recovery record. Already-entitled reconciliation runs after queue release.

Implementation order:

1. Closed route parser/table and core profile/access transport.
2. Bounded checkout response parsing and durable account/session-fenced operation recovery.
3. Browser compiled profile, policy endpoint and session storage wiring.
4. Focused behavioral tests, type/lint checks and independent integration review.

Verification must cover every fixed QA route, unknown profiles, unchanged production routes,
transport failure without fallback, malformed checkout identities/URLs, worker restart,
cross-account and same-account session replacement, storage failure before opening checkout,
and completion failure without a paid grant. Actual hosted/provider/device verification remains
an activation gate; synthetic tests do not satisfy it.

The coordinator owns backend source, hosted configuration and provider checks, and acknowledged
ownership of Swift/native, build-helper and app-webview profile propagation. This branch owns TS
core and browser consumers only. It does not activate payment testing or alter earlier QA packages.

Verification recorded so far:

- The independent review reproduced legacy settings fallback, a concurrent completion race, and
  identity-switch cleanup erasing a new account's operation. New regressions failed before repairs.
  Final review has no remaining findings; 94 recovery/session/transport tests pass, including
  queued session replacement, storage rejection, authentication failure and already-entitled
  recovery. The reviewer also passed two independent authentication hold-release controls.
- Workspace suites passed after the queue repair: core 4,711, Chromium 580, Safari 286,
  owner-admin 58; visual harness 53 passed and one existing skip. The final authentication hold
  and two added tests were checked with the full core suite: 4,713 passed, 39 existing skips.
- Root lint and scoped final changed-file lint pass; final root typecheck and ordinary
  Chrome/Firefox/Safari/webview/admin builds pass. These are ordinary compilation checks, not
  an assembled provider-connected QA cohort.
- Local browser fixtures: 307 passed, 21 skipped. The restricted launch failed; the permitted
  run completed successfully. This suite checks synthetic pages and ordinary packaged modes.
- No hosted routes, provider transactions, signed device packages or physical devices were
  verified by this branch. The earlier preliminary packages remain unchanged.
