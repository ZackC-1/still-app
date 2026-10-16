# Safari Mac TikTok blocked page: lost redirects, dead actions and Off + reload

Status: implemented and locally verified; owner device retest pending

Covers three owner QA findings on Safari for Mac (build 2.1.1.361), all on the TikTok blocked page:

- **ISS-0067 (major):** "Open TikTok this time" does nothing (MAC-24 fail, MAC-25/26 blocked).
- **ISS-0068 (major):** with TikTok Blocker Off, reloading the blocked page keeps it blocked; only
  re-typing the address opens TikTok (MAC-29). Same symptom as ISS-0054 on iPhone, which stays fixed.
- **ISS-0066 (minor):** a TikTok tab sometimes shows only the bare "This site is blocked." line
  instead of the full "TikTok stays closed." page (MAC-22 first attempt).

iPhone Safari, Chrome and Firefox pass the same steps with the same code.

## Evidence (macOS 27.0.1, Safari 27.0.1, QA window 15:45-16:05)

Read from the Mac's unified log (`com.apple.WebKit` Loading, ServiceWorker and Extensions
categories). No page content or URLs are logged; only WebKit page and process identifiers.

1. **Safari for Mac moves the tab into a different web view whenever it switches between TikTok
   and Still's own page.** Every redirect created a new `WebPageProxy` in the extension process
   (`constructor` + `restoreFromSessionState` + `loadRequest`) and closed the TikTok one, for
   example TikTok page 9558 -> blocked page 9592 at 15:59:31, and TikTok 8694 -> blocked page 8714
   at 15:54:02. Re-typing the address swapped back to a new web-content view (9722 at 16:00:37).
   iPhone Safari keeps one view per tab. WebKit's extension API models a view swap as a tab
   replacement (`didReplaceTab` -> `tabs.onReplaced(added, removed)` plus a new tab id).
2. **Still treats `tabs.onReplaced` as the tab closing.** The route deletes the tab's saved
   original address (`forgetTab(removed)`), the one-tab authority revokes the allowance
   (`closeTab(removed)`), and the blocked page now speaks from the new tab id, which has no saved
   address. Every blocked-page answer is then "unavailable": the buttons stay inert (ISS-0067),
   and Off + reload has no original address to return to (ISS-0068). The reloads at 15:59:37,
   15:59:42 and 16:00:33 reloaded page 9592 in place and never navigated, with no WebKit API error
   logged, which matches an "unavailable" answer rather than a failed browser call.
3. **A TikTok same-document navigation can cancel Safari's view swap.** At 15:51:49.79 the blocked
   page committed in a new view, TikTok's own script changed its URL at 15:51:50.02, and Safari
   closed the blocked page's view at 15:51:50.35 and kept TikTok (again at 15:52:33). The content
   script was hidden and waiting, saw no unload, and after its 5 s grace painted the bare
   "This site is blocked." fallback (ISS-0066 screenshot 3.52.08 PM).
4. **The background unloads about two minutes after the page's last port activity.** WebKit
   unloads a non-persistent background once its ports have been idle for 2 minutes
   (`delayForInactivePorts`), which disconnects the blocked page's document port. The page treats
   that disconnect as permanent (`host.stop(true)`), so any blocked page left open for a few
   minutes becomes inert. Observed: the background service worker was terminated at 15:57:31 while
   two blocked pages were open.

Finding 2's replacement event is inferred from WebKit's API model and the observed swaps; Safari's
debug-level tab events are not persisted, so it was not captured directly. Findings 1, 3 and 4 are
in the persisted log.

## Approach

1. **Replacement keeps the tab's TikTok state (route + authority).** On `tabs.onReplaced(added,
   removed)` the route moves the saved original address to the new id (never overwriting a newer
   record) and settles any open confirmation; the one-tab authority carries only a completed
   allowance to the new id through its existing pending-write protocol, and cleans up anything
   unfinished. Closing a tab still ends everything. No settings write, no new permission.
2. **The Safari blocked page survives a dropped document port and a slow replacement.** The page
   reconnects its document port before each background request when the port has gone, waits for
   the background to acknowledge the connection, and retries the start handshake a bounded number
   of times when the first answer is unavailable. Chrome and Firefox keep their current host
   behaviour (the options are Safari-only).
3. **The Safari content script re-asks once the redirect is lost.** If the TikTok document is still
   alive a short time after "redirected", it asks the background again (bounded), keeping the page
   hidden, before falling back to the in-page block.

## Tests first

- Safari host composition (`packages/ext-safari/lib/tiktok-host.test.ts`): blocked in tab 7, Safari
  replaces it with tab 8 for the blocked page -> screen is `blocked`; request opens the confirmation;
  confirm grants; open returns the original URL; Safari replaces 8 -> 9 for TikTok and the content
  script in tab 9 is `allowed`; a different tab is still redirected. TikTok Off + reload in the
  replaced tab returns `open` with the original URL and writes no grant or setting.
- Core authority and route units for replacement: completed grant carried, unfinished grant not
  carried, a newer record in the added tab is never overwritten, closing still revokes.
- Host: Safari start retries an unavailable answer and reconnects through `prepare`; Chrome default
  unchanged.
- Content script: a redirect that never leaves re-asks (bounded), then falls back.

## Retest (owner, installed package)

MAC-22, MAC-24, MAC-25, MAC-26, MAC-29 (TikTok part). Controls: IOS-23/24/28, CH/FX TikTok steps.
Also leave a Safari Mac blocked page open for 3+ minutes, then use "Open TikTok this time".

## Risks

- If Safari does not fire `tabs.onReplaced` for the swap, part 1 is inert and the device retest will
  show it; parts 2-3 still apply. The owner retest is the acceptance gate.
- Carrying an allowance across replacement must not widen it: only a completed grant moves, only
  to the browser-reported replacement id, and the old id is cleaned up first.

## Verification

- Failing first (before the fix): Safari composition replacement tests returned `unavailable`
  for screen and Off + reload (5 failing); host link/retry tests (4 failing); content-script
  re-ask tests (2 failing); the document-link module did not exist.
- After: `pnpm lint`, `pnpm typecheck`, `pnpm test` (core 5315, ext-chromium 769, ext-safari 371,
  owner-admin 58 passing), `pnpm build`, and both Playwright fixture lanes (see the PR).
- Not verified here: installed Safari for Mac behaviour. The QA Mac's TikTok blocker was Off, and
  its settings were not changed, so no live replacement event was captured.
