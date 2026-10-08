# Sandbox client route profile and purchase recovery

Status: combined client source integrated and locally verified; final independent repair review, protected PR integration, hosted activation and complete QA packages remain pending.

Base: `da022966f405713beeebeb5c0c367bd3b051331b`.
Branch: `feat/v31-client-cohort-integration-20261008`.

Bind browser clients to one compiled `production` or `shared-hosted-sandbox` route profile.
The profile is separate from access-proof environment and is never selected by a request,
URL, stored setting, or message. Unknown profiles and profile/trust disagreement hold requests.
The QA session spine also requires modern settings sync; its backend rejects legacy settings
table/RPC access and never subscribes to legacy settings realtime.
Existing production defaults, free blocking, and free settings sync retain their behavior.

Propagate the same explicit profile through the Apple app, Safari extension, native policy/access
configuration, WebView and sandbox packaging helper. A complete paid QA build requires the explicit
sandbox profile and matching packaged public trust; source preparation does not activate the build.
Modern signed-in settings sync remains free while purchase verification is pending or unavailable.

For Apple account purchases, native code verifies current hosted Auth, obtains the fixed-route
signed response and commits accepted proofs/removals atomically under session/generation fences.
Known account removals affect only their holder/right/revision and preserve independent local
rights. Native purchases require fresh sales policy before charging; Restore remains available
independently of current sales. Launch, foreground and Restore recover a confirmed account's web
purchase through the existing accepted cache; ordinary sign-in never links a local purchase.
The background account refresh starts only after successful current native account-status
publication and never delays free sync or code verification. Stale account/token/session completions
cannot publish benefits or release another operation's busy state. Cache refresh notifications read
the existing authority after durable native publication, including account removal on sign-out.

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
5. Shared packaging/native/WebView profile and trust propagation.
6. Native account authority, scoped removals and fresh purchase policy; free modern sync.
7. Apple account-only launch/Restore composition, mounted screen and session-failure regressions.

Verification must cover every fixed QA route, unknown profiles, unchanged production routes,
transport failure without fallback, malformed checkout identities/URLs, worker restart,
cross-account and same-account session replacement, storage failure before opening checkout,
and completion failure without a paid grant. Actual hosted/provider/device verification remains
an activation gate; synthetic tests do not satisfy it.

The coordinator owns this combined TS/browser, Swift/native, build-helper and WebView source cohort.
Backend runtime and SQL preparation remain separate PRs #363 and #362. This branch does not deploy
those dependencies, activate payment testing or alter earlier QA packages. Dedicated provider inputs,
reviewed hosted activation, matched signed packages and actual installed journeys remain acceptance
gates after source review and merge.

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

Combined cohort verification:

- Native/helper/WebView units and free modern sync are integrated with the browser source. The
  final core suite passed **4,756 tests**, with **39 existing skips**, across 186 files. All workspace
  type checks, scoped final lint, ordinary workspace builds and 12 maintained WebView entry tests
  passed. Ordinary unpacked Chrome output is 1.41 MB; signed download size is still unmeasured.
- The final composed Apple authority/host/session set passed **311 tests** across 11 suites.
  Regressions failed before fixes for account-only recovery, delayed identity publication, stale
  link cleanup and rejected native account-status writes. Mounted screen checks exercise the real
  typed bridge/factory/cache path using controlled native transport.
- Before the final WebView/session composition, the native source passed **436 StillKit tests**
  and both ordinary unsigned Debug Apple app/extension targets compiled successfully. No Swift
  source changed in that final composition; final signed cohort/Xcode packaging remains pending.
- These checks do not certify hosted gateway/RPC permissions, OTP on devices, RevenueCat/Apple
  sandbox purchases, refunds, deliberate link/transfer or TestFlight/device behavior. Final combined
  source review and new-head CI are pending; the whole redesign is incomplete.

## Independent review repairs and final client checks (8 October)

The full independent review of `85256159` confirmed four concerns: native account
verification availability was lost in a durable acknowledgment, copied Apple example
configuration suppressed free sync, account changes could leave a canceled Buy preflight
pending, and executable coverage did not exercise the maintained native reconciliation
arm. Commits `a9d3f5f` and `7d99b667` retain the authority status across the bridge,
represent optional production defaults accurately, reset only canceled preflights, and
add executable native router regressions. Existing local rights and completed native
purchases retain their recovery protection. Configured browser background tests also
exercise sandbox sales gating and independent completion/Restore while sales are Off.

Exact runtime head `7d99b667` passed the full workspace: core 4,770 with 39 existing
skips; Chromium 585; Safari 286; WebView 15; owner-admin 58; visual harness 53 with
one existing skip. Workspace lint, type checks and ordinary builds passed. Browser
fixtures passed 307 with 21 existing skips; StillKit passed 437. Both updated unsigned
iOS and macOS apps and Safari extensions built successfully. All eight GitHub checks
on this head passed. One workspace repeat hit an existing five-second UI timeout
while Xcode builds ran concurrently; its focused 56-test file and the subsequent full
workspace run passed without changing the timeout.

Claude exhausted its bounded review without a usable artifact. The owner-authorized
Muse Spark source fallback and a bounded direct-read followup completed with no
actionable findings; the followup resolved its initial truncated native span and
test-body inspection limits. Separate independent repair-delta review remains in
progress. These source/fixture/compiler checks do not certify hosted activation,
provider purchases/refunds, signed packages or physical devices.
