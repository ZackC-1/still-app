---
title: Preserve mobile YouTube renderer-owned nodes during Shorts blocking
category: ui-bugs
track: bug
problem_type: integration_error
module: packages/core/rules
applies_when: Mobile YouTube selects a Home topic but its feed becomes empty with blocking enabled
date: 2026-09-10
last_updated: 2026-10-08
status: active
tags: [youtube, mobile, selectors, dom-ownership]
---

A topic button becoming selected does not prove its results rendered. Test both the selected topic
and visible ordinary results after repeated in-page transitions; a full reload bypasses that path.

Removing nodes owned by a page renderer can interrupt its next update. A renderer may retain child
references between renders and call `removeChild` on them before appending replacement results. If
an extension already removed a child, this throws `NotFoundError` after the renderer has cleared
ordinary content. The built-extension regression models this ownership contract explicitly; it is
synthetic, not a copy of YouTube's private renderer implementation.

The bundled rules retain Shorts nodes under the mobile `ytm-app` root and hide them with scoped CSS.
The existing removal selectors exclude descendants of that root. Desktop removal remains intact,
including desktop layouts using `ytm-shorts-lockup-view-model` without a mobile app root. Ordinary
cards and topic controls remain usable. The selectors continue to classify Shorts by their existing
shelf/card structure and thumbnail destination, not arbitrary text or links in descriptions.

CSS also handles reused cards: changing a thumbnail from `/shorts/` to `/watch` stops matching the
rule, without waiting for JavaScript to notice a newly inserted element. Changing the blocking
switch removes the active root class and restores hidden content without rebuilding the feed.

Keep the rule version, bundled signature and generated CSS together. Newer signed remote rules
remain authoritative; this is a bundled-rule correction, not an engine override of remote actions.
No website event handlers, pagination requests or native settings are patched.

Verification must include the disabled healthy control, repeated topic selection, Shorts remaining
hidden, off/on restoration, reused ordinary cards, and desktop Shorts-filter recovery. Browser
fixtures do not substitute for a signed physical iPhone Safari check of the reported Home layout.

For an optional control that hides a dedicated mobile parent, selector support must cover the application's OS minimum. Safari added `:has()` in [15.4](https://webkit.org/blog/13096/css-has-pseudo-class/); a sole-child comments rule using it can otherwise leave the panel/scrim visible while its teaser disappears. The compiled [YouTube adapter](../../../packages/core/src/rules/youtube-extras.ts) retains modern CSS and adds the same-feature marker selector. The [marker hook](../../../packages/core/src/content/markers.ts) admits that fallback only when the primary selector is unsupported and the signed hide surface consumes its exact selector. It marks only a panel with one element child matching the comments section; a mixed or recycled panel loses the mark.

Only an effective fallback owns a mutation observer. Relevant class and child-list records refresh affected panels; marker writes and unrelated mutations do not rescan the document. Off, revocation, another service and teardown clear owned attributes, including detached panels, and disconnect. The fallback never removes renderer-owned children or changes site settings.

The composed Safari content regression models a rejecting older CSS parser as well as selector feature detection. It failed with the original CSS-only rule and passes with the fallback, including microtask delivery before paint, late panels, mixed content and free Shorts preservation. The complete core suite and built-extension YouTube fixtures pass. These are synthetic and Chromium proofs; physical Safari and Firefox Android acceptance remain separate.
