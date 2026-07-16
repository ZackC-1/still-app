---
title: Codify store-asset compliance rules as a contract test, not a review habit
date: 2026-07-16
category: conventions
module: docs/release/screenshots
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Creating or regenerating a store asset governed by a written platform compliance policy (App Store promoted-IAP image, store screenshots, promo tiles)"
  - "A regeneration script can silently rewrite assets that were already reviewed, submitted, or rights-cleared"
tags: [app-store-connect, promoted-iap, guideline-2.3.2, playwright, contract-test, store-assets, render-pipeline]
---

# Codify store-asset compliance rules as a contract test, not a review habit

## Context

Apple rejected the same asset lineage **twice** under Guideline 2.3.2: v1 was an app paywall
screenshot showing the price; v2 (a brand card with a small subline) carried the same
small-text exposure. Each rejection cost a review cycle. The rules that would have prevented both
were knowable in advance and written down nowhere a machine could check them — they lived in a
reviewer's memory and in Apple's prose.

## Guidance

**Write the compliance rules down once, canonically, then pin the machine-checkable subset in CI.**

The rules for Apple's promoted-IAP image, now canonical in
`docs/release/screenshots/store-ready/README.md`:

- **Unique artwork — never a screenshot**, and never resembling the app icon. Apple composites the
  real app icon into the lower-left of search placements, so repeating the icon's motif reads as
  "confusable with your app icon."
- **No price text** or price-shaped strings anywhere in the image.
- **Text limited to the product name** at **≥ 12% of canvas height**, so it survives the ~120px
  thumbnail Apple renders in search.
- **Bottom-left 30% × 30% content-free** (an internal convention — Apple publishes no figure —
  reserving the icon-composite region).

Two engineering moves generalize beyond this asset.

**1. Scope the regeneration script, and fail loudly on a bad scope.** The render script regenerates
*every* store asset by default, including rights-reviewed screenshot sets that must not change. A
positional type filter keeps a rerun to what actually changed — and an unknown filter must exit
non-zero *before* rendering, because a silent zero-match run exits 0 and leaves the previous asset
in place looking freshly regenerated:

```js
const knownTypes = new Set(promos.map((p) => p.type));
if (only && !knownTypes.has(only)) {
  console.error(`Unknown filter "${only}" — valid types: ${[...knownTypes].join(", ")}`);
  process.exit(1);
}
```

**2. Assert the invariants in CI.** `tests/playwright/store-assets.spec.ts` renders the asset's
source and asserts what a DOM can prove: no price-shaped text, the product name is the *only* text,
the headline clears the size floor, no visibly-styled element intrudes on the safe zone, the
committed JPEG is 1024×1024 (via a SOF-marker scan of the binary), and the filter guard itself
exits 1 on a bad argument.

Two details that make the safe-zone assertion actually hold:

- **Sweep generically, not by class allowlist.** Enumerate every text node plus every visibly-styled
  element; a hard-coded `.mark, .screen` list silently stops covering whatever motif is added next.
- **Assert the probe found something.** An empty rect list passes a "nothing intrudes" loop
  vacuously — a broken probe would look like a clean design.

```js
expect(boxes.length).toBeGreaterThan(0);   // the probe works
for (const b of boxes) {
  const intersects = b.x < zone.right && b.y + b.h > zone.top;
  expect(intersects, `${b.what} intersects the lower-left safe zone`).toBe(false);
}
```

**Know the boundary.** These checks prove the *source*, not the shipped raster. Final visual sign-off
of the rendered image stays human, and the doc says so rather than implying CI covers it.

## Why This Matters

A rule enforced only by manual review is enforced exactly once, then forgotten — which is how the
same asset got rejected twice. Each 2.3.2 rejection costs a full Apple review cycle; a red test costs
seconds. The scoped filter prevents a quieter but equally expensive mistake: clobbering already-submitted,
already-rights-cleared screenshot sets while fixing one unrelated image, with git showing only that
"the binaries changed."

## When to Apply

- Any store asset with narrow, platform-specific compliance rules (safe zones, text limits, no-price
  rules, icon-confusability) that has a scripted regeneration path.
- Any generator whose default run rewrites more than the thing you are changing — scope it, and make
  a mis-scoped run fail loudly rather than no-op.
- When a rejection notice offers a remedy explicitly, weigh taking it — a compliant asset is worth
  nothing if the store will not process it (see the §7 reference below).

## Examples

- `docs/release/screenshots/store-ready/README.md` — canonical rules, rejection history, and current
  status ("NOT currently uploaded — the field is empty by choice").
- `tests/playwright/store-assets.spec.ts` — the contract test; auto-enrolled by the existing fixtures
  project's `testMatch`, so it runs in the standard CI gate with no config change.
- `docs/release/screenshots/source/render.mjs` — the scoped filter and its loud validation.
- `docs/release/01-apple-app-store.md` §7 step 6 — the ASC-processing-failure trail and deletion
  rationale.

## Related

- `docs/solutions/conventions/codify-cross-platform-visual-contract-in-tests.md` — the same
  codify-the-contract pattern applied to cross-surface UI parity. This doc is that pattern extended to
  a non-UI surface governed by an *external* compliance spec rather than internal consistency.
- `docs/solutions/integration-issues/asc-submission-silently-omits-first-iap.md` — from the same
  release cycle.
