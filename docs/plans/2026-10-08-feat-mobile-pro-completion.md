# Complete Still Pro behavior on Safari and Firefox Android

Status: Related videos and Comments source merged; remaining mobile extras and installed acceptance unfinished. No physical-device or provider acceptance is claimed.

Base: `a1e880067b5c1a0e6fc066c47f759de36816a023`.
Branch: `feat/v31-mobile-pro-completion-20261008`.

The owner requires all twelve Still Pro extras on Safari and Firefox Android for the complete sandbox testing packages. On 8 October the owner also explicitly approved hiding sponsored posts in Facebook's phone feed, extending the previous desktop-sidebar-only behavior of `facebook.sponsored`. Keep the same benefit identifier and number of extras. Ordinary posts, explicitly opened content, messages, contacts, and every free blocking/sync outcome must remain usable.

## Implementation boundaries

- Inspect public mobile YouTube structures before extending related, endscreen, comments, live chat and autoplay behavior. Record observed structures separately from synthetic preservation fixtures. Do not treat a Chromium phone viewport as Safari or Firefox Android acceptance.
- Inspect Facebook's mobile feed advertising boundary. Require a positive advertisement marker owned by the actual top-level feed unit; a word in an ordinary post, comment, shared link or accessibility wrapper cannot authorize hiding its parent. Ambiguous units stay visible. Preserve the existing desktop sidebar boundary.
- Hide renderer-owned elements reversibly; never remove mobile renderer children, alter site/account settings, patch network/player payloads or expand host permissions. Autoplay prevention must preserve Replay, deliberately chosen playlists, next-item controls and normal playback, with bounded actions and cleanup.
- Extend the shared capability table and native capability registry only for behavior implemented with meaningful structural and preservation tests. Add mobile context at real consumers if needed; do not infer a platform from persisted user data or purchase state.
- Update the V3 product record and affected visible descriptions for the newly approved sponsored-feed behavior. Keep shipped 2.x paid flags disabled. No new analytics schema or payment-provider changes.

## Verification

Meaningful regressions must demonstrate the missing mobile behavior before repairs, restored content when Off, uncertain/ordinary content preserved, recycled nodes and in-page transitions, independent free Reels/Shorts behavior, account/Pro-state revocation, and lifecycle teardown. Run focused unit and built-extension structural fixtures, applicable type/lint/build checks and native registry tests. Review the implementation independently before protected integration.

Physical iPhone/iPad Safari and Firefox Android tests, including actual feed layouts and foreground/background autoplay, remain explicit engineering/owner QA gates. Record inability to obtain authenticated Facebook feed structure as a blocker for that feature rather than inventing a selector or claiming all twelve work.

This source unit does not activate purchases, deploy the backend, alter live accounts or certify the full sandbox package set. The existing complete-delivery contract remains authoritative.

## Checkpoint: mobile YouTube comments

Integrated worker source `3719d088` adds the observed individual mobile comments entry point and
dedicated, sole-child comments engagement panel. It preserves the shared metadata carousel and
ambiguous mixed panels. Public phone-layout observation established those structures; the
headless public player could not play the video, so actual mobile countdown/end-screen behavior
and live chat remain unverified.

Regenerated `packages/core/rules/format2.json` with the existing `sign-format2` development signer;
no production signing key or hosted publication was used. Both generator consistency/free-rule
protection and mobile rule suites passed (14 tests). The Chromium build succeeded and the two
built-extension YouTube fixture suites passed all 21 tests, including mobile comments recycling,
Off restoration, preservation and synthetic autoplay/playlist controls. These fixture tests use
Chromium capabilities and the existing disposable purchased-access seam. They do not prove the
Safari capability registry, Safari execution, Firefox Android or real mobile player behavior.

Owner deferred Facebook sign-in; the private setup guide is prepared. Mobile sponsored-feed
selectors and the corresponding all-twelve capability expansion remain unfinished.

## Checkpoint: Safari capability composition

The isolated Safari capability unit adds `youtube.related` and `youtube.comments` to the shared
TypeScript and native paid-on registries, with one shared parity fixture. A composed modern Safari
entry test exercises the packaged mobile rules, saved settings, cryptographically verified synthetic
local access, unknown evidence, On/Off restoration, revocation, mixed-panel recycling, chosen
playlist preservation, independent free Shorts and teardown. Missing capabilities failed the new
TypeScript regressions before repair. All 150 focused TypeScript tests and 419 StillKit tests passed;
the complete native run required permitted OS notification access. Core typecheck and touched-file
lint passed. End-screen, live chat, autoplay and Facebook sponsored behavior remain unsupported
on Safari. WebKit/device, Firefox Android and live provider acceptance remain outstanding.

## Checkpoint: supported Safari selector fallback

Full independent review of frozen `371339e5` confirmed that the dedicated comments panel relied on `:has()`, unavailable before Safari 15.4 despite Still's iOS 15.0/macOS 12.0 deployment targets. The existing marker hook now provides a compiled fallback only when the browser cannot parse the primary selector. It marks exactly the sole-child comments panel, observes only relevant class/child-list mutations while Comments is effective, clears detached marks, and disconnects on Off, revocation, service changes and teardown. The primary CSS path stays in use on modern browsers. No OS minimum, host permission or paid authority rule changed.

The composed Safari regression rejected unsupported CSS rules and failed before repair. Both selector-support lanes now pass accepted-access, saved-On, Off, revocation, late insertion, pre-paint recycling and independent free Shorts controls. The repaired tree passed 124 focused tests and the complete core suite (4,818 passed, 39 existing skips), typecheck with zero errors/warnings, scoped lint, Chromium/Safari resource builds and 21 built YouTube fixtures. Initial broad-run failures came from temporary package-subpath aliases and restricted Swift cache access; corrected verification tooling passed without source/assertion/timeout changes. Regenerated only the existing development rule seed/signature.

Earlier integrated runtime `371339e5` also passed 439 StillKit tests and unsigned Release iOS Simulator/macOS app-plus-Safari builds with matching packaged resources. Those native artifacts predate this fallback and are not final repaired binaries. Fresh independent review, current required CI, protected merge and the repaired native package cohort remain open. Simulated unsupported-selector coverage does not establish execution on physical older Safari, current iPhone Safari or Firefox Android.

## Checkpoint: reviewed source merged

PR #366 merged exact reviewed head `39158647feabe1d2f090935451ab9afbcdb6400e` into main `dfa0d4046a9e5b9a7ed0b588b0aedb537f7c631c`. All eight checks passed, including the complete fixture suite, real Firefox checks and StillKit. Full independent review identified the older-Safari selector issue above; the repaired source and final fixture-only follow-up each received an actual Claude review with no remaining actionable findings. The final fixture follow-up moves fixture-owned layout declarations to inline styles so the dormancy test does not mistake them for extension CSS; runtime bytes are unchanged.

Repaired runtime `cbddffc5373b756cf2b811621919ffbb3be0cb08` also produced successful unsigned Release iOS Simulator and macOS app/Safari-extension builds. The packaged WebUI and Safari resources matched the generated resources with no SHA mismatch. The built extension passed the older-selector fallback control; a separate 1,554-shape selector/marker comparison found no mismatch. These are source, synthetic and unsigned-build proofs. Signing, matching hosted configuration, TestFlight delivery and physical-device journeys remain open. Safari still has eight evidenced extras; Firefox Android has ten. Autoplay, end-screen and live-chat mobile observation, plus the owner-deferred authenticated Facebook feed investigation, remain incomplete.
