# Track 6 — Safari mobile validation

Current reference for Still 2.0.0; reviewed September 14, 2026. Mobile support means websites in
Safari on iPhone/iPad. Native social apps and mobile Chrome/Firefox are outside this release.

## Evidence already recorded

The owner completed extensive Mac/iPhone testing and confirmed Shorts removal, normal YouTube
video behavior and Shorts-to-watch redirection. Preserve the candidate and scope of each recorded
result in the [release status](2026-09-14-release-status.md) and linked evidence. Do not restart
completed testing merely because the [September 8 candidate matrix](2026-09-08-still-2-certification.md)
contains older unverified rows.

Physical iPad testing is **SKIPPED / UNVERIFIED**, explicitly accepted by the owner because no device
is available. It is not a pass and is no longer an action to request from the owner for this release.
Simulator/browser emulation and screenshot capture do not replace physical evidence.

## Checks for a new or changed candidate

Use the exact signed artifact and record build/hash, OS/browser, device, date and result. Repeat
only checks affected by a new change, failure or unresolved concern; keep older evidence attributed.

| Area | Expected behavior |
|---|---|
| Activation | Enable Still in Safari and grant site access; all four services work with no sign-in/purchase. |
| YouTube | Shorts shelves/entry points disappear; direct and in-page Shorts links open the normal player; regular videos and search remain usable. |
| Instagram/Facebook | Reels surfaces/routes are blocked; ordinary posts/messages remain usable. |
| TikTok | The whole website is blocked. Native TikTok is unaffected. |
| Controls | Global and each service switch apply and persist. There is no pause-on-this-site control; legacy pauses must not disable current blocking. |
| Lifecycle | Restart, background/foreground, offline use and sign-out retain local blocking/settings. |
| Apple propagation | App/WebView/Safari changes propagate through the App Group and already-open supported pages. |
| Layout | Native onboarding, app and Safari sheets remain usable at narrow widths, light/dark and larger text; record accessibility evidence separately. |
| Optional sync | Use an approved disposable account environment; verify first/existing-account adoption, peer edits/reconnect, account switching and deletion/re-creation. |

The hosted disposable-account lifecycle/final certification remains in issue #153. A local mocked
or SQL-backed test cannot establish hosted Auth/provider behavior. Never use the owner's real
account as disposable test data.

## Diagnosing a failure

Inspect the affected Safari page through Web Inspector with the user's device. Identify whether
permissions, settings, route handling or website markup caused the failure before changing rules.
Current YouTube filtering avoids removing framework-owned renderer structures and scopes Shorts
removal to the renderer/link that owns them. See
[mobile renderer preservation](../solutions/ui-bugs/mobile-youtube-renderer-owned-nodes.md) and
[search continuation behavior](../solutions/ui-bugs/youtube-shorts-search-continuation-loop.md).

Safari and Firefox use the early content-script redirect; Chromium additionally uses network DNR.
Do not promise zero visible flash on every Safari navigation based on a Chromium fixture result.
Remote selector fixes require a configured rule endpoint and a newer valid production-signed set;
the bundled seed remains the offline fallback. Inspect the actual artifact/configuration rather
than assuming every historical build had remote updates enabled.

## Future surfaces and historical evidence

Firefox for Android would need a separately approved compatibility and privacy/test track before
being advertised or enabled. There is no Google Play artifact in this release; see
[future Android scope](05-future-google-play.md).

The [previous mobile checklist](../archive/pre-2.0-reference-refresh/docs/release/06-mobile-blocking-validation.md)
preserves the original numbered tests and dated results, including paid and removed-pause behavior.
Use it for historical attribution, not as the current acceptance contract.
