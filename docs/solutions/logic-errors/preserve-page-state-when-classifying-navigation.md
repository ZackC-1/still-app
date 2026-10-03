---
title: Preserve current page state while classifying a prospective navigation
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core
applies_when: A stateful page classifier evaluates a destination before browser navigation commits
date: 2026-10-03
status: active
tags:
  - navigation
  - blocking
  - media
---

A blocked discovery link can affect the page the user is leaving before that navigation commits.
Two failures share this boundary: canceled navigation can leave hidden media audible, and a
consumed push can replace the origin history entry so Back skips search results or the feed.

The format2 page session stores the current service and effective feature plan. Evaluating a
prospective destination mutates that plan. An unsupported destination clears it, although the
original DOM remains hidden when navigation is canceled or fails. Media handlers then see no
active feature and return before reevaluating the current URL.

In `packages/core/src/content/index.ts`, keep the prospective decision, then immediately restore
the current-URL plan with the same settings and access snapshot before returning, invoking a
callback or redirecting. This uses the existing compiled classifier; it needs no second engine,
observer or timer. Cancellation and same-home consumed navigation keep the plan backing the
current DOM. Off and stop still release media protection.

History intent must travel separately from the normalized URL. A trusted link, Enter or consumed
push has not created a history entry yet: use `location.assign` for the normalized destination.
An initially loaded forbidden URL or replacement navigation already has replacement intent:
use `location.replace`. `packages/core/src/content/redirect.ts` carries that mode through the
existing port, preserves ordinary native history behavior and rejects synthetic, modified,
download and non-self interception. An absent push capability must not silently replace history.

The previous approach, calling `location.replace` for every normalization, was safe only after
the forbidden entry had loaded. Applying it before commit overwrote the origin entry.

Verification is retained in:

- `feature-media.test.ts`: canceled external navigation and same-home consumed Reels continue
  quieting hidden media; Off and stop release it. The prior implementation fails both cases.
- `format2-navigation.test.ts`: consumed YouTube/Facebook pushes preserve the modeled origin;
  replacement and legacy cases preserve their original intent.
- `tests/playwright/format2-navigation.spec.ts`: real trusted Chromium click/Enter through the
  maintained extension entry normalize before commit and Back returns to the origin. Actual
  atomic settings commits, navigation exceptions and stop are exercised on synthetic pages.
  Removing the trusted-event guard makes the synthetic-event regression fail.

The browser harness enables format2 only in a disposable copied artifact, checks shipping bytes
stay unchanged and removes its profile. These checks cover the exercised Chromium lifecycle;
they do not establish other browser floors or device behavior.
