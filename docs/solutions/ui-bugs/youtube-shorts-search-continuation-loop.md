---
title: Hidden Shorts search results can trigger repeated YouTube continuation requests
category: ui-bugs
track: bug
problem_type: logic_error
module: packages/core
applies_when: YouTube Shorts disappear but a selected Shorts search keeps loading
date: 2026-09-09
status: active
tags:
  - youtube
  - selectors
  - pagination
---

YouTube's desktop search chips changed to buttons with `role="tab"` and a visible Shorts label,
without the `title="Shorts"` attribute used by Still's existing selector. The Shorts filter remained
available even though its results were removed. When advertising slots were also hidden, the empty
viewport exposed YouTube's continuation trigger and it kept fetching more results.

Measure search requests and main-frame navigations separately: the reproduced symptom was repeated
`youtubei/v1/search` requests, not page reloads. With Still alone, advertising slots occupied enough
space to mask the problem. In an isolated public search, collapsing those slots increased requests
from 2 to 19 over 12 seconds with one main-frame navigation.

The content script marks the narrowly scoped Shorts chip for the existing authored hide surface.
The rule set and root classes still own hiding, so disabling Still restores the chip. On a search
page with Shorts already selected, it activates that same bar's All tab once. This lets YouTube
preserve the query and load normal results. A slow or failed response does not cause repeated clicks.
The helper only runs when the active rule set enables its marker selector, preserving downloaded
rule overrides.

The current labels are English. Missing or changed labels cause the helper to leave the page alone;
this is not a claim of coverage for every locale or future layout. Do not guess that the first tab
means All, broadly hide chips, or disable general pagination.

Verification covers the real content-script boundary, removal of the protection as a failing mutant,
and built Chromium/Safari-bundle fixtures with off/on restoration. Safari-bundle fixtures run in
Chromium and do not replace real Safari testing. Against live YouTube, the fix restored All and
17 visible ordinary video results, preserved the query, and held requests at 4 over 12 seconds.

Supported sites continually change. Keep narrow observed-markup fixtures and repeat live smoke
checks, including navigation, search filters, ordinary content, and interaction with another blocker.
Treat selectors as maintained integrations; passing a fixture proves only the captured layout.
See [the implementation plan](../../plans/2026-09-09-001-fix-youtube-shorts-filter.md).
