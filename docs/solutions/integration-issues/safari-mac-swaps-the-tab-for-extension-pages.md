---
title: Safari for Mac swaps the tab when it shows an extension page
category: integration-issues
track: bug
problem_type: integration_issue
module: packages/core, packages/ext-safari
applies_when: An extension-owned page in a Safari for Mac tab relies on the tab id, a document port, or the page that redirected to it
date: 2026-10-15
status: active
tags:
  - tiktok
  - safari
  - macos
  - tabs
---

On Safari for Mac the TikTok blocked page looked right but did nothing: "Open TikTok this time"
was inert, reloading after turning TikTok Off stayed blocked, and some TikTok tabs got only the
bare "This site is blocked." line. iPhone Safari, Chrome and Firefox were fine with the same code.

What the Mac's unified log showed (`log show --predicate 'process == "Safari" AND subsystem ==
"com.apple.WebKit"'`, Loading and ServiceWorker categories; no URLs are logged):

- Safari for Mac does not navigate the existing web view to an extension page. It builds a new
  `WebPageProxy` (`constructor`, `restoreFromSessionState`, `loadRequest`) for Still's page and
  closes TikTok's, and does the reverse when the person types an address. WebKit's extension API
  models a swapped tab as a replacement: `tabs.onReplaced(added, removed)` with a new tab id. The
  replacement event itself is debug-level and was not in the persisted log; it is inferred from
  the swaps and from every symptom matching a lost per-tab record.
- If TikTok's own script changes its address while that swap is in flight, Safari can close the
  new extension view and keep TikTok. The content script, still alive and hidden, then fell back.
- WebKit unloads a non-persistent background once its ports have been idle for 2 minutes, which
  disconnects every page's `runtime.connect` port.

Still treated `tabs.onReplaced` as the tab closing, so the saved original address and any
allowance were deleted and the page asked under an id with no record; it also ended the page on
any port disconnect. The fix, all without new permissions or settings writes:

- `tiktok-blocked-route.ts` moves the saved address to the replacement id (a newer record for that
  id wins) and makes answers for the new id wait for the move.
- `tiktok-tab-authority.ts` `replaceTab` carries only a completed allowance, through the normal
  pending-write protocol, and queues the new id first so its checks wait for the carry.
- The Safari page reconnects its document port before each request
  (`ext-safari/lib/tiktok-document-link.ts`, acknowledged by `TIKTOK_DOCUMENT_READY`), and retries
  its first screen answer a bounded number of times.
- The Safari content script asks again when it is still alive after "redirected".

Debug-level WebKit extension events (`Replaced tab`, `Opened tab`, port add/remove) are not
persisted. To see them live: `log stream --debug --predicate 'process == "Safari" AND subsystem ==
"com.apple.WebKit" AND category == "Extensions"'` while reproducing.

Prevention: on Safari treat the tab id and the extension page's web view as replaceable. Key
per-tab state so it can follow `tabs.onReplaced`, never treat a port disconnect as the page's end,
and test the Mac composition with a replacement in the harness
(`packages/ext-safari/lib/tiktok-host.test.ts`).
