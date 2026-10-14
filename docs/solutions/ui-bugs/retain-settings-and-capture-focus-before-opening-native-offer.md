---
title: Capture focus before hiding native settings for the Pro offer
category: ui-bugs
track: bug
problem_type: ui_bug
module: packages/app-webview
applies_when: A full-screen offer temporarily replaces settings and Close must restore the initiating control
date: 2026-10-14
status: active
tags: [apple, focus, svelte, navigation]
---

# Capture focus before hiding native settings for the Pro offer

Mac feature locks open the existing full Still Pro offer through the settings producer's navigation
callback. That callback opens `PurchaseView`; only its explicit acquisition action starts a purchase.

`AppleSettingsHost.svelte` keeps the Mac settings subtree mounted and hidden while the offer is open.
This preserves the expanded service section and the actual initiating lock element. Close reveals
that subtree, restores focus with `preventScroll`, and restores the prior document scroll position.
The offer receives focus on Close and starts at the top. The iOS subtree keeps its existing mount
behavior.

Capture the initiating element and scroll position synchronously in the navigation callback,
**before** setting the offer open. A Svelte effect runs after the DOM update: by then a real browser
may have cleared focus from the newly hidden subtree. jsdom can retain that focus, so an effect-only
implementation can pass component assertions while failing in a browser.

`apple-pro-host.integration.test.ts` exercises all twelve Mac locks through the actual settings
host, verifies Close focus and section preservation, and commits a free TikTok switch afterward.
A disposable Chromium run with synthetic native messages also checked all twelve routes, visible
initial offer heading, exact scroll restoration, and zero purchase calls. Browser geometry checks
covered normal/enlarged text and light/dark rendering. These checks do not certify native WebKit,
VoiceOver, or physical device lifecycle.

For asynchronous native status observations, use the same ownership principle described in
[session lifecycle invalidation](../logic-errors/invalidate-sync-work-by-session-lifecycle.md):
a canceled earlier read cannot publish into a reactivated screen or clear its newer in-flight read.
