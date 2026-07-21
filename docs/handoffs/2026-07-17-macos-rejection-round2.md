---
title: "macOS 1.0(5) re-rejection — heal and resubmit handoff"
status: active
created: 2026-07-17T00:00:00-07:00
source: "claude"
intended_receiver: "any"
---

# macOS 1.0(5) re-rejection — heal and resubmit handoff

## Objective

Heal whatever Apple flagged on the **macOS** 1.0 build 5 resubmission and get it back into review.
iOS is progressing independently and must not be disturbed.

## ✅ RESOLVED DIAGNOSIS (2026-07-17 pm) — rejection reason obtained + root-caused

The rejection is **Guideline 5.1.1(v) — Data Collection and Storage (account deletion)**, NOT a
credential/sign-in failure. Apple: "The app supports account creation but does not include an
option to initiate account deletion." This was a NEW finding ("upon further review"), distinct
from the 5.1.1(v) sign-in-before-purchase item PR #111 already fixed. **The prime suspect below
(read-back gate / sign-in failure) was WRONG** — kept for the record, but do not chase it.

**Root cause = discoverability, not missing code.** Account deletion is fully implemented and IS
in build 1.0(5): `App.svelte` renders a "Delete account" button → "Delete your account?" confirm
→ `delete-user` edge function, in every signed-in state (`not-entitled`, `pro-device-only`,
`entitled-syncing`). The control is signed-in-only; Still's purchase-first flow never requires
sign-in, so the reviewer bought/loaded without signing in and never reached the account screen.
`docs/privacy.html` already documents the path.

**Resolution chosen (Path A): reply + screen recording — NO rebuild.** Apple's own Next Steps
offer this ("or if it is already in place, reply … with a screen recording"). Paste-ready reply,
App-Review-Notes addition, and click-by-click recording script were drafted (this session's
scratchpad `macos-5.1.1v-reply.md`). Human steps remaining: capture the recording on a Mac, then
reply in the macOS Resolution Center with it attached. No version bump, no queue reset, iOS
untouched. If iOS later bounces on the same guideline, the identical recording resolves it.

## ⚠️ Original FIRST STEP (superseded — kept for history)

This handoff was written right after the user learned macOS was rejected again; **the actual
rejection text was not captured**. The receiving session's first action is to get it from the user:
ask them to paste the Resolution Center message (or a screenshot), or read it via the ASC API. Do
not start fixing anything before the guideline number and reviewer notes are in hand. The user
said "it looks like a small one," so expect a narrow, macOS-specific issue — but confirm, don't
assume.

## Live ASC state — API-verified 2026-07-16 ~23:xx (query again first thing)

| Object | State | Build |
|---|---|---|
| macOS 1.0 | **REJECTED** | 5 |
| iOS 1.0 | **IN_REVIEW** | 5 |
| `still_sync` (IAP) | **IN_REVIEW** | — |

Read this: **iOS is under active review and the IAP is in review with it** — the split-submission
trap from 2026-07-16 was fixed and held. Only macOS bounced. **Do NOT pull, edit, or resubmit the
iOS submission** while it is IN_REVIEW; touching it resets its queue position. macOS is independent
and safe to work on.

## How to re-verify state (do this before trusting any UI)

The ASC web UI changed and misled us badly on 2026-07-16 — verify via the API. Full recipe is in
auto-memory `[[still-asc-api-access]]`. Essentials:

- Auth: ES256 JWT, `aud: appstoreconnect-v1`, 15-min exp, `kid` header. Python + `pyjwt[crypto]`.
- Key: `~/.appstoreconnect/private_keys/AuthKey_XAYK9WM65V.p8`; Key ID `XAYK9WM65V`; Issuer ID
  `e335e339-60e0-411f-81a4-f4cf8bc484e9` (public identifier, safe); App ID `6784061138`; IAP id
  `6784065634`.
- `GET /v1/apps/6784061138/appStoreVersions?include=build` → per-platform state + build.
- `GET /v1/apps/6784061138/inAppPurchasesV2` → IAP `state`.
- `GET /v1/reviewSubmissions?filter[app]=6784061138` then `/{id}/items`; item ids are base64 →
  `<submissionId>|<typeCode>|<entityId>`, typeCode 6 = version, 17 = IAP. (`?include=` → HTTP 400.)
- A working `asc-decode.py` lived in this session's scratchpad (now gone) — re-derive from the
  memory doc; it is ~15 lines.

## Completed this session (2026-07-16) — all merged to main `2cb996a`

- **PR #114** — v3 promoted-IAP image + scoped `render.mjs iap` filter + Playwright contract test
  `tests/playwright/store-assets.spec.ts` + build number bumped 4→5 across all 8 pbxproj configs.
- **PR #115** — recorded §1b/§1c gate results (email templates fixed, OTP smoke PASS both address
  types).
- **PR #116** — IAP promotional image DELETED in ASC (see below) + runbook records why.
- **PR #117** — four `docs/solutions/` learnings compounded from the day.
- **Backend LIVE**: `review-signin` Edge Function deployed to hosted `kikpgrreradotvvefdgd`
  (ACTIVE, `verify_jwt=false`); secrets `REVIEW_SIGNIN_EMAIL` + `REVIEW_SIGNIN_CODE` set; smoke
  200/401/404; §1c email cross-check byte-identical.
- **Both archives built + uploaded as 1.0 (5)**, review branch hash-verified inside each binary
  (`98d288b9…`), macOS universal (x86_64+arm64).
- **iOS + macOS + IAP submitted together** (after fixing the split-submission trap).

## Rejections resolved so far (context for the new one)

- **2.3.2 ×2 (promo image)** — resolved by DELETING the image. Apple would not process the v3
  asset (broken placeholder in JPEG+PNG across Chrome/Incognito/Safari; file, extensions, network
  all ruled out — ASC-side failure). Deletion is Apple's own offered remedy; field is Optional.
  v3 art stays committed (`docs/release/screenshots/store-ready/apple/still-pro-iap-v3-1024x1024.jpg`)
  for a **post-approval** retry. Do NOT re-add it pre-approval.
- **2.1(a) OTP error** — most-likely root cause found + fixed: the live "Confirm signup" template
  still carried `{{ .ConfirmationURL }}` (mail-scanner prefetch consumes the shared OTP token).
  Both templates now token-only; verified end-to-end.
- **2.1(a) demo account** — `review-signin` fixed-code path live; credentials in the gitignored
  `packages/app-webview/.env.review-signin` (read with `cat`; NEVER print to chat/commit).
- **5.1.1(v)** — purchase-first flow shipped 2026-07-15 (PR #111).

## Likely shape of the new macOS-only rejection (confirm against the real text)

iOS passed the same content and is in review, so a macOS-*only* bounce points at something
platform-specific rather than the shared purchase/OTP/metadata story. Plausible categories, in
rough likelihood order — but the reviewer notes are authoritative:

- A crash or broken behavior on the reviewer's Mac (sandbox purchase, sign-in, or extension
  enablement behaving differently on macOS 26 than on iPad).
- macOS-specific Safari-extension enablement confusion (the notes use
  `Safari > Settings > Extensions`; confirm that path is current on the review OS).
- A 2.4.x macOS guideline (sandbox entitlements, hardened runtime) — less likely given prior builds
  compiled and ran, but possible.
- Something in the macOS App Review Information fields (sign-in toggle, credentials) that differs
  from what was verified. NOTE: the **read-back gate was never run** (see below) — a paste error in
  the macOS credentials would produce exactly a 2.1(a)-style code failure on macOS only.

## Remaining / never-completed gates (candidates for the actual cause)

1. **Read-back gate — NEVER RUN.** We verified the credentials in the *notes text* authenticate
   (HTTP 200), but never verified the strings actually saved in the macOS ASC Username/Password
   fields. A paste error there reproduces the 2.1(a) dead end on macOS specifically. **Run this
   first after getting the rejection text**: read the values back out of the saved ASC fields and
   curl them against the function → must be 200.
2. **On-device VALIDATION — NEVER RUN.** `docs/release/VALIDATION.md` items 7–8 then 1–6, on a Mac
   (and an iPad for iOS). If the reviewer hit a real on-device failure, this is where it would have
   shown up first.

## Build / archive facts (if a new macOS build is needed)

- Repo is pinned at **1.0 (5)**; a new binary needs the build bumped again (all 8
  `CURRENT_PROJECT_VERSION` in `apps/apple/Still/Still.xcodeproj/project.pbxproj`).
- **macOS has no archive script.** Before Xcode GUI Product → Archive you MUST run
  `pnpm --filter @still/app-webview build` and `pnpm --filter @still/ext-safari build` — the targets
  only COPY prebuilt `dist/`, so a GUI archive without the prebuild silently ships a stale bundle.
  Verify the bundle hash inside the `.xcarchive` matches the freshly-built `dist/assets/index-*.js`.
- iOS archive is scripted: `apps/apple/scripts/archive.sh` (needs ASC key env; issuer ID above).
- The July 15 `Still-1.0b4*.xcarchive` files in `apps/apple/build/` are OBSOLETE — never upload them.
- Gotcha: `find` is aliased to `bfs` on this machine — use `/usr/bin/find` on `.xcarchive` paths.
- Xcode warnings seen (all pre-existing/benign, not blockers): two WebBridgeRouter actor-isolation
  warnings from commit 095000c, and a `strip` code-signature warning on the `.appex`.

## Blockers and human gates

- **The rejection text itself** — receiver must obtain it from the user before acting.
- Archiving, uploading, on-device validation, and ASC portal actions are all human-gated.
- Secret values live only in the gitignored env file — read locally, never commit or print.

## Next safe action

1. Get the macOS rejection guideline + reviewer notes from the user.
2. Re-query the ASC API to confirm current state (macOS may have moved; iOS may have resolved).
3. Run the read-back gate on the macOS credentials — the cheapest thing that could explain a
   macOS-only 2.1(a).
4. Then plan the fix scoped to macOS only. **Leave the iOS submission untouched while IN_REVIEW.**

## Relevant references

- Release runbook: `docs/release/01-apple-app-store.md` §7 (July 16 ordered runbook + change-coupling matrix)
- Deploy gates: `docs/release/extension-purchase-deploy-checklist.md` §1b/§1c
- On-device: `docs/release/VALIDATION.md`
- Solution docs (this session): `docs/solutions/integration-issues/asc-submission-silently-omits-first-iap.md`,
  `docs/solutions/conventions/hosted-portal-config-drifts-verify-live.md`,
  `docs/solutions/conventions/codify-store-asset-compliance-in-tests.md`,
  `docs/solutions/security-issues/keep-secrets-out-of-cli-args-and-transcripts.md`
- Auto-memory: `still-release-execution-plan`, `still-asc-api-access`
- HEAD at handoff: `2cb996a` on `main`, clean tree.
