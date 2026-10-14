---
title: Recheck committed settings when reloading a blocked document
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core
applies_when: An extension-owned blocked page survives after its service is disabled
date: 2026-10-14
status: active
tags:
  - tiktok
  - safari
  - document-authority
---

Reloading the TikTok blocked page could keep showing the block after the saved TikTok setting
was Off. Entering the original URL again worked because that navigation evaluated the service
setting, while the extension-owned page's screen handshake only checked one-tab allowances.

The screen handshake in `packages/core/src/content/tiktok-blocked-route.ts` now reads committed
settings. An explicit global or TikTok Off returns the validated original target to the current
blocked document. This is ordinary browsing recovery, so it neither grants an allowance nor
writes settings. Missing settings or failed authority checks leave the page unavailable.

The handler captures document authority before asynchronous reads, then revalidates the original
target and captured document before replying. The Safari connection proof must not be recaptured
after a replacement document connects. `browser-tiktok-tab-authority.ts` owns that capture and
check; `tiktok-blocked-host.ts` also rejects replies belonging to an obsolete host lifetime.

Keep the original target through this recovery so a lost reply can be retried. Existing allowance
and tab-cleanup paths continue to own its retirement. Turning blocking back On uses the normal
block path; recovery must not create a lasting bypass.

Regression coverage includes the real Safari route composition and native document registry,
service Off and global Off, missing or failed reads, replaced or disconnected documents, changed
targets, stale host replies, and blocking after turning On again. The Safari TikTok Playwright
suite exercises its compiled extension resources in Chromium; it does not certify physical
iPhone behavior or Safari's browser frame.

Prevention: treat an extension-owned recovery screen as a separate entry point. Reevaluate
authoritative settings when it reloads, and bind every asynchronous recovery to the document
that requested it.
