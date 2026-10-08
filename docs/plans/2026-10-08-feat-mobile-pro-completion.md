# Complete Still Pro behavior on Safari and Firefox Android

Status: source preparation; structural investigation in progress. No physical-device or provider acceptance is claimed.

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
