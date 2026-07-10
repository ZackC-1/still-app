# Functional Testing Matrix - 2026-07-09

Live checklist for the post-iOS-submission release validation session.

## Current Release Priority

1. iOS physical-device functional testing.
2. macOS app and Safari extension testing, then macOS App Store submission blockers.
3. Chrome extension free and Pro testing.
4. Firefox desktop free and Pro testing.
5. Firefox Android mobile YouTube validation, if a device or emulator is available.

## Status Key

- Todo: not started.
- Pass: verified in the current release cycle.
- Fail: app behavior is wrong and needs a fix.
- Blocked: cannot finish because of external auth, portal, device, or account state.
- N/A: not in scope for this release surface.

## Cross-Surface Matrix

| Surface | Free YouTube Shorts blocking | Pro gating and entitlement | Settings sync | Purchase/restore | Store/release blockers | Status | Notes |
|---|---|---|---|---|---|---|---|
| iOS app + Safari extension on physical iPhone | Pass | Partial | Pass | Partial | None known after iOS submission | In progress | App Store version 1.0 submitted with build 2. User reports installed iOS app is working effectively for YouTube. Entitled account shows sync active. Instagram Reels and TikTok block as expected. Facebook Reels route blocks; gray tab residue tracked in issue #58. Local settings persistence works as expected. Price lookup passed as `Unlock Pro - $1.99`. Apple sandbox purchase remains blocked by sandbox account auth. |
| macOS app + Safari extension | Pass | Pass | Partial | Todo | macOS screenshots and submission still pending | In progress | Local macOS debug build passed for version `1.0` build `2`. Direct YouTube Shorts URLs block and redirect to `/watch?...`; sidebar and search cleanup are effective. App shows `Synced across your devices`; Instagram Reels, Facebook desktop Reels, and TikTok are blocked/removed in Safari. Same-device TikTok toggle propagation works. Universal Purchase should share `still_sync`. |
| Chrome desktop extension | Todo | Todo | Todo | Todo | Web Pro portal/deploy checklist still needs verification | Todo | Uses RevenueCat Web Billing through `create-web-checkout`. |
| Firefox desktop extension | Todo | Todo | Todo | Todo | AMO listing/privacy/package validation still pending | Todo | Same web Pro flow as Chrome; Firefox MV3/runtime behavior needs smoke testing. |
| Firefox Android | Todo | N/A | N/A | N/A | Device/add-on install availability | Todo | Validate mobile YouTube redirect/removal only if available. |

## Known Proven Evidence

- iOS App Store Connect version 1.0 is submitted for review with build 2 selected.
- App Store product lookup through RevenueCat resolved `still_sync`; iOS paywall showed `Unlock Pro - $1.99`.
- RevenueCat promotional entitlement for `zack+sandbox2@cadmuslabs.co` reconciled to Supabase user `2a592992-74b2-4b6d-b425-cf5db63510a5`.
- Supabase row confirmed `public.entitlements.still_sync = true`, `source = reconcile`, `updated_at = 2026-07-09 01:16:56.864474+00`.
- App showed `Synced across your devices` after sign-in.
- CORS/OPTIONS issue on authenticated Supabase Edge Functions was fixed and deployed.

## Known Gaps

- Real Apple sandbox purchase is not proven because the physical device sandbox Apple Account would not stay signed in.
- Facebook mobile home-screen Reels icon remained visible on iOS Safari even though the Reels route blocks. Safari Web Inspector showed the icon as `[role="tab"][aria-label="reels, 4 of 6"]`. Source fix is implemented with `[role="tab"][aria-label*="reels" i]`; device retest is pending.
- Near-realtime latest-surface-wins settings sync is desired follow-up behavior, not current release behavior. Implementation spec: `docs/plans/2026-07-09-001-near-realtime-settings-sync-spec.md`; parallel-agent prompt: `docs/plans/2026-07-09-002-near-realtime-sync-pr-agent-prompt.md`.
- macOS App Store submission still needs its release walkthrough.
- Web Billing purchase flow still needs browser extension sandbox validation before web Pro launch.

## iOS Physical-Device Checklist

Test device: TBD.

### 1. Free YouTube Shorts Blocking in iOS Safari

- [x] Confirm Still is installed on the physical iPhone.
- [x] Confirm Safari extension is enabled: iPhone Settings -> Apps -> Safari -> Extensions -> Still -> On.
- [x] Confirm Still has permission for YouTube: Settings -> Apps -> Safari -> Extensions -> Still -> youtube.com -> Allow.
- [x] Open Safari and cold-navigate to `https://m.youtube.com/shorts/<known-short-id>`.
- [x] Expect direct Shorts URL to land on `/watch?v=<id>` before the Shorts player starts.
- [x] From the `m.youtube.com` home feed, tap a Short.
- [x] Expect in-feed Short tap to redirect to a normal watch page.
- [x] On the `m.youtube.com` home feed, confirm the Shorts shelf is gone while normal video cards remain.
- [x] Confirm the bottom pivot bar has no Shorts tab.
- [x] Search for a term that usually surfaces Shorts and confirm Shorts shelves/results are removed while normal results remain.
- [ ] Toggle YouTube off or pause on the site in the Still app, reload Safari, and confirm Shorts return.
- [ ] Toggle YouTube back on, reload Safari, and confirm Shorts are gone again.

Result: Pass for core YouTube free-tier blocking based on user-observed physical iPhone behavior. Off/on toggle still pending.

### 2. Pro Mobile Surfaces on iOS Safari

Use entitled Supabase account `zack+sandbox2@cadmuslabs.co`.

- [x] Sign in to Still as the entitled test account.
- [x] Confirm the app shows Pro/sync state, expected text: `Synced across your devices`.
- [x] In Safari, visit `https://m.instagram.com` and confirm normal posts remain.
- [x] Navigate to or tap Reels on Instagram and confirm Reels surfaces/routes are blocked or removed.
- [x] In Safari, visit `https://m.facebook.com` and confirm normal Facebook browsing remains.
- [x] Navigate to `https://m.facebook.com/watch/reels/` or tap a Reels surface and confirm it is blocked or removed.
- [x] In Safari, visit `https://m.tiktok.com` and confirm the Still blocked-site placeholder appears.
- [ ] Sign out or use a free/signed-out state and confirm Instagram, Facebook, and TikTok are not Pro-blocked while YouTube Shorts still are.

Result: Partial pass. Entitlement and Pro blocking are active. Instagram Reels are removed and respect the app on/off toggle. TikTok is blocked effectively. Facebook Reels route is blocked. Facebook home-screen Reels icon was visible before the selector fix; source fix is implemented and awaits device retest. Normal Instagram posts may be slightly slower to load; not yet confirmed as a regression.

### 3. Settings Sync and Entitlement Persistence

- [x] While signed in as the entitled account, change a Still setting in the app.
- [x] Quit and relaunch the app.
- [x] Confirm the setting persists locally.
- [x] Confirm the Pro/sync state remains visible.
- [ ] If a second Apple surface is ready, sign in there and confirm the same setting appears.
- [ ] If reinstall testing is practical, reinstall the app, sign in again, and confirm entitlement and synced settings return.

Result: Pass for local iOS persistence and entitlement persistence. Cross-device sync validation remains pending until another surface is tested.

### 4. Restore/Reconcile Behavior

- [ ] In the Still app, open the Pro/paywall/account area.
- [x] Tap Restore Purchases, if present.
- [x] Confirm the promotional RevenueCat entitlement reconciles and the app remains Pro.
- [x] Confirm no `Sync paused - no connection` state appears.
- [ ] If restore reports no App Store purchases but Pro remains active after sign-in/reconcile, record the exact UI copy.

Result: Not directly visible in the signed-in entitled state. User reports no Restore Purchases option is visible for the signed-in account. Entitlement remains reconciled and persistent (`Synced across your devices`), so this is not blocking iOS functional validation.

### 5. Apple Sandbox Purchase Retry

- [ ] Retry only after the core functional tests above pass, or if a fresh device/account state makes it cheap.
- [ ] On iPhone, check Settings -> Developer -> Sandbox Apple Account, or Settings -> App Store -> Sandbox Account, depending on iOS version.
- [ ] Attempt the purchase from the Still paywall.
- [ ] If the sandbox account signs out again or fails before an Apple purchase sheet completes, mark Blocked by Apple sandbox auth and continue.
- [ ] If a purchase sheet completes, verify RevenueCat customer state and Supabase entitlement update.

Result: Blocked by previous Apple sandbox account auth issue.

## Running Results Log

| Time | Surface | Test | Result | Evidence / notes |
|---|---|---|---|---|
| 2026-07-09 | iOS | Starting functional test pass | In progress | Matrix created from release checkpoint and mobile validation docs. |
| 2026-07-09 | iOS Safari | Free YouTube Shorts blocking | Pass | User reports the installed iOS app seems to be working effectively for YouTube. Core YouTube checklist marked pass; explicit off/on toggle remains pending. |
| 2026-07-09 | iOS app | Entitlement state | Pass | Entitled test account shows `Synced across your devices`. |
| 2026-07-09 | iOS Safari | Instagram Pro Reels blocking | Pass | Reels section removed. Toggling Still on/off makes Reels disappear/reappear as expected. Normal posts may be slightly slower to load, but this is subjective and not yet treated as a blocker. |
| 2026-07-09 | iOS Safari | Facebook Pro Reels blocking | Partial | `m.facebook.com/watch/reels/` is blocked by Still, but the Reels icon remains visible from the Facebook home screen. Needs selector inspection. |
| 2026-07-09 | iOS Safari | TikTok Pro blocking | Pass | `m.tiktok.com` is blocked effectively. |
| 2026-07-09 | iOS Safari | Facebook home Reels icon selector | Fix implemented | Web Inspector showed `div role="tab" aria-label="reels, 4 of 6"`. Added `[role="tab"][aria-label*="reels" i]`, bumped/re-signed seed `1.0.1`, regenerated packaged Pro CSS, and added regression coverage. Device retest pending after reinstall or production rule-set publish. |
| 2026-07-09 | iOS Safari | Facebook home Reels icon retest | Still visible | Route blocking still works. Cause identified: Xcode copies `packages/ext-safari/dist/safari-mv3`, while the first fix only regenerated entrypoint CSS. Rebuilt Safari dist and updated Apple build phases/scripts to rebuild extension assets before copy. Retest pending with freshly installed bundle. |
| 2026-07-09 | iOS Safari | Facebook gray-box retest | Still present | Reels viewing is blocked, but Facebook home still shows a large gray Reels residue/box even after clean reinstall. Treat as a live Facebook mobile DOM/layout issue; inspect the gray element directly. |
| 2026-07-09 | iOS Safari | Facebook gray-box follow-up | Tracked | Filed https://github.com/ZackC-1/still-app/issues/58. Do not block release testing; Reels viewing is blocked, remaining issue is visual residue/polish on Facebook mobile. |
| 2026-07-09 | iOS app | Settings persistence | Pass | User reports persistence is working as anticipated after toggling settings/reopening. Cross-device sync still pending. |
| 2026-07-09 | iOS app | Restore purchases visibility | Not visible | Restore Purchases option is not visible for the signed-in entitled account. Entitlement remains active via reconcile/promo grant, so iOS restore is not treated as a release blocker. |
| 2026-07-09 | Apple apps | Restore purchase decision rule | Documented | Clarified in `docs/monetization-design.md` and `docs/release/04-revenuecat.md`: entitled Supabase accounts auto-provision via reconcile; unentitled accounts should see upgrade plus secondary `Restore purchase` in the paywall; Restore is specifically Apple receipt recovery for an Apple ID that already owns `still_sync`. |
| 2026-07-09 | macOS | Start macOS validation | In progress | Moving to macOS app/Safari extension testing and macOS App Store submission blockers after iOS core validation. |
| 2026-07-09 | macOS | Local debug build | Pass | `apps/apple/scripts/build.sh macos` completed successfully. Built app is `Still.app` version `1.0` build `2` in Xcode DerivedData. |
| 2026-07-09 | macOS Safari | Direct YouTube Shorts URL | Pass | User reports Safari first blocks `/shorts/` and then redirects to `/watch?...`, which is the expected behavior. |
| 2026-07-09 | macOS Safari | YouTube navigation/search cleanup | Pass | Shorts are hidden effectively. Shorts remain removed when searching broadly for `music`; normal YouTube remains usable. |
| 2026-07-09 | macOS app | Entitlement state | Pass | App shows `Synced across your devices` for the entitled test account. |
| 2026-07-09 | macOS Safari | Instagram Pro Reels blocking | Pass | Reels are blocked/removed in Safari as expected. |
| 2026-07-09 | macOS Safari | Facebook Pro Reels blocking | Pass | User reports Facebook desktop Reels are blocked effectively. |
| 2026-07-09 | macOS Safari | TikTok Pro blocking | Pass | User reports TikTok is blocked. |
| 2026-07-09 | macOS app/Safari | Same-device TikTok setting propagation | Pass | Turning TikTok off/on in the macOS Still app affects Safari blocking as expected. |
| 2026-07-09 | Sync | Near-realtime settings sync spec | Documented | Created `docs/plans/2026-07-09-001-near-realtime-settings-sync-spec.md` for server-authoritative latest-surface-wins sync using Supabase RPC server timestamps, monotonic versions, and Realtime subscriptions. |
| 2026-07-09 | Sync | Parallel implementation prompt | Documented | Created `docs/plans/2026-07-09-002-near-realtime-sync-pr-agent-prompt.md` to direct a separate Codex worktree session through implementation, local verification, PR creation, CI fixes, and merge. |
