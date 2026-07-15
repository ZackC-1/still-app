# Release Validation

Current validation record for commit
`5678e1b4ef683d0ba1857dff68583c9b40437b95` on July 10, 2026.

## Release-candidate addendum — commit `22b2717`, build 3 (July 10, 2026)

Main advanced past the record above by PRs #69 (branding unification + review
fixes), #70 (Edge Function hardening, migrations 0010–0011), #72 (docs), and
#73 (Apple build number 2 → 3). Against `22b2717`:

| Area | Result |
|---|---|
| GitHub CI on every merged PR (lint, typecheck, unit, build, Deno, Playwright) | Pass |
| Local full gate: install, build (incl. Firefox variant), lint, typecheck, tests | Pass |
| Hosted backend: migrations 0001–0011 applied; all six functions redeployed; 401 fail-closed smoke test | Pass |
| Selector canary: scheduled daily (14:00 GMT) with invocation token; Slack notify wired and delivery-tested | Pass |
| Store zips (chrome, firefox) + full-monorepo AMO source zip rebuilt; manifests verified | Pass |
| iOS + macOS archives, version 1.0 build 3, uploaded to App Store Connect | Done |

The manual cross-surface checks recorded below were performed at `5678e1b`;
the on-device pass for `22b2717` (mobile blocking §A rerun, branding
spot-checks, sandbox purchase against the rewritten webhook path, and the
still-outstanding Firefox-Android §B check) is the next gate before any store
submission.

## Automated Checks

| Area | Result |
|---|---|
| GitHub CI: lint, typecheck, unit tests, builds | Pass |
| GitHub CI: Supabase Edge Functions | Pass |
| GitHub CI: Playwright fixtures | Pass |
| Chromium production build | Pass |
| Firefox production build | Pass |
| Safari extension tests | Pass: 4 files, 25 tests |
| Safari extension typecheck and production build | Pass |
| Signed macOS app and embedded extension build | Pass |
| iOS simulator build, install, launch, and visual smoke | Pass |
| Signed physical-iPhone build and installation | Pass |
| Local Supabase migrations and database tests | Pass: 32 tests |

The linked hosted Supabase project and the local database both include migrations `0001` through
`0009`. Migration `0009_profile_settings_server_clock.sql` is required by these clients and must be
present in every environment where this build is installed.

## Manual Cross-Surface Checks

All checks used the same signed-in entitled test account. Account identifiers are intentionally not
recorded in the repository.

| Scenario | Result |
|---|---|
| Baseline settings converge across active surfaces | Pass |
| Chrome global setting updates macOS and an open supported page | Pass |
| macOS service setting updates Chrome popup, options, and content | Pass |
| iOS setting updates macOS and Chromium surfaces | Pass |
| macOS setting updates an already-open Safari page | Pass |
| Firefox writes converge with Apple and Chromium surfaces | Pass |
| Later server-accepted conflicting write wins everywhere | Pass |
| Settings persist after popup, app, and device restart | Pass |
| Safari exposes exactly one registered Still extension | Pass |

Chrome, Firefox, macOS, macOS Safari, the iOS simulator, and a physical iPhone were included in the
release cycle. The physical iPhone accepted the signed build; interactive behavior was subsequently
validated manually.

## Release Boundary

The client and backend contract is validated. App Store, TestFlight, Chrome Web Store, and Firefox
AMO submission remain separate human-gated release actions. Delaying store review does not permit
delaying migration `0009` in an environment that receives this client build.

## Purchase-first addendum — feat/apple-purchase-first-pro-flow (July 15, 2026)

Validation record for the Guideline 5.1.1(v) purchase-first restructure
(plan `docs/plans/2026-07-15-001`, ADR 0003), run on the feature branch before merge.

| Area | Result |
|---|---|
| Lint (eslint, all packages) | Pass |
| Typecheck (all 6 packages, svelte-check + tsc) | Pass: 0 errors |
| Vitest: core 479 · ext-safari 48 · ext-chromium 20 | Pass: 547 tests |
| StillKit `swift test` (incl. the full StampPolicy matrix) | Pass: 87 tests |
| Supabase Deno: lint (36 files) · check (6 functions) · tests | Pass: 101 tests |
| Extension production builds (chrome-mv3, firefox-mv3, safari-mv3) | Pass |
| Playwright fixtures (free/Pro behavioral contract, 4 services) | Pass: 16 tests |
| iOS Release compile (unsigned, `Still (iOS)` incl. extension) | Pass: 0 errors |
| macOS Release compile (unsigned, deployment target now 12.0) | Pass: 0 errors |

### On-device sandbox checklist (human-gated, before releasing build 4)

Run on iOS AND macOS unless marked; sandbox Apple ID; RevenueCat restore behavior = default
transfer; `still_sync` Family Sharing OFF.

1. AE1 (macOS first — the rejected platform): fresh signed-out install → Get Still Pro → sandbox
   purchase completes → Reels/TikTok blocking active in Safari with no account; success screen
   shows Create free account / Not now as two equal-weight buttons and does NOT auto-dismiss.
2. AE2: sign in on the entitled device (new account) → account gains Pro (check Chrome with the
   same email); sign out → device keeps Pro; home screen shows "Still Pro is active on this
   device."
3. AE4 + AE10 (iOS ONLY — macOS Group Containers survive reinstall, so a plain macOS
   delete+reinstall passes vacuously; on macOS delete the Group Container manually to exercise
   the purge): delete + reinstall → launch → Safari regains Pro without an account; no purge
   window observed on first page load after launch.
4. AE11: on a device whose purchase is attached to an account, sign out → "Already purchased?
   Restore" → Pro confirmed; verify in Supabase the account's entitlement is untouched.
5. AE6 (revocation — StoreKitTest local refund or sandbox `beginRefundRequest`, NOT
   clear-purchase-history): refund → next launch/foreground re-locks the app and the stamp.
   Separately: clear purchase history → app re-locks (noSignal cell) while Safari rides the TTL.
6. AE9 (Ask-to-Buy, `simulatesAskToBuyInSandbox`): purchase signed out → pending → approve →
   foreground the app → success screen appears, Safari unlocked, still no account.
7. OTP flow (the 2.1(a) rejection item, plan 2026-07-15-002): sign-in code entry — wrong code
   shows the calm retry line, expired code offers a new one, resend works after the cooldown, and
   a rate-limited send/verify shows wait copy with the button locked (never a "try again" that
   invites hammering).
8. Review sign-in (fixed code, on a real device — this is also the first browser-context call
   into an edge function from the WKWebView's file:// origin, so it doubles as the CORS check):
   enter the review address → "Email me a code" renders the sent state with NO email dispatched →
   the fixed code signs in. Then the full reviewer lifecycle in one pass: sandbox purchase →
   attach lands Pro on the account (check a second surface syncs a toggled setting) → delete the
   account in-app → sign in again with the SAME address + fixed code (a fresh user id is created)
   → Restore purchase → reconcile lands the entitlement on the new account.

Store submission remains a human-gated action per the release runbook §7 (resubmission). The
§1b/§1c hosted-config and review-signin gates in `extension-purchase-deploy-checklist.md` are HARD
pre-upload blockers for build 4.
