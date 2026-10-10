---
title: Add paid-tier-only code without changing the shipped bundles
category: conventions
track: knowledge
problem_type: maintainability
module: packages/ext-chromium
applies_when: Adding behaviour that must exist only in builds compiled with PAID_TIER_ENABLED on
date: 2026-10-10
status: active
tags: [bundles, paid-tier, rolldown, extensions]
---

## Problem

`PAID_TIER_ENABLED` is a source constant (`packages/shared-types/src/entitlement.ts`); paid QA
builds flip it in their own source copy. Shipped 2.x builds must stay byte-for-byte as they were.
The browser Still Pro card (Buy, Restore, re-checks) needed code in shared modules: the session
factory in `background.ts`, the shared `ProOfferCard`, the UI controller, the controller setup.
Some ways of writing a gate fold away in the minified bundle. Others leave bytes behind.

## What folds away (verified with rolldown 1.2.8 + Vite 8 minify)

- `if (PAID_TIER_ENABLED && …) { … }` blocks, and `(PAID_TIER_ENABLED && x) || y`, which becomes `y`.
- A conditional spread in an object literal: `...(PAID_TIER_ENABLED ? { extra } : {})`.
- A choice of function at a call site: `(PAID_TIER_ENABLED ? withExtra : original)(args)`. This
  became plain `original(args)`. It let the background wrap `createExtensionSession` without
  touching the deps literal.
- Svelte template expressions that fold to the original, for example
  `{#if canBuy && (offer?.priceNote || (PAID_TIER_ENABLED && offer?.checkoutPriced))}`.
- `declare field?: T` on a class. It emits nothing; a plain `field?: T` emits a class field.
- A value import used only inside a folded branch, from a module with no top-level side effects.
- Dynamic `import()` of a paid-only chunk inside a folded branch. In the configured lane the chunk is
  not emitted at all.

## What leaves bytes behind

- **A new `@still/shared-types` import in a module that had none.** The background wraps that
  package in a lazy initializer, so each newly importing module adds a `V()`-style init call. This
  happens even when the imported constant folds. Put the gated code in a module that already
  imports it (`background.ts`, `extension-setup.ts`, `controller.svelte.ts`), or in a new module
  that is referenced only from folded code.
- **Hoisting an inline object into a variable** so gated code can read a property from it. The
  minifier keeps the variable and the property read.
- Adding an entry to the session protocol registry (`SESSION_PROTOCOL`). It needs the flag in a
  module that has no shared-types import (see the first point). The paid "may I offer Buy?" question
  therefore uses its own listener (`lib/checkout-availability.ts`). It has the same message kind and
  the same `isExtensionPageSender` rule, and is registered only through the folded factory choice.

## Unconfigured-lane caveat

In the unconfigured lane (no Supabase values), the options page's lazy settings wrappers are still
emitted as unreferenced chunk files, even though no entry imports them. Their contents can change
with paid-only edits while every reachable file stays identical. Check which files reference a
changed chunk before treating a difference as shipped behaviour.

## Verification

Build both lanes before and after, and compare every output file with
`node scripts/bundles/identity.mjs snapshot … / diff …` in the same checkout (base commit checked out,
then the branch). For this change, it reported the configured lane byte-identical across Chrome,
Firefox, the Safari extension and the app web view. Unconfigured Safari and app web view were identical; unconfigured Chrome and
Firefox differed only in the unreferenced chunks above. A source copy with the switch flipped
confirmed that the paid build does contain the new code.

## Prevention

Gate every paid-only addition with the compiled constant, at a point the bundler can fold. Then
diff the configured build before claiming the shipped bundles are unchanged. If a diff shows only
renamed minified identifiers, look for a new import or a kept variable rather than real new logic.
