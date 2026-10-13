---
title: Turning the paid tier on revived a retired tier tag and left TikTok open
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core/src/rules
applies_when: Changing what is free or paid, adding a paid-tier gate, or reading rule-set tier tags while PAID_TIER_ENABLED can be compiled on
date: 2026-10-12
last_updated: 2026-10-12
status: active
tags:
  - paid-tier
  - tiktok
  - rule-set
  - testing
---

## Symptom

ISS-0036, owner QA test set 6: in the Chrome paid sandbox QA build (2.1.1.335), a fresh
signed-out profile showed "Still is active" and TikTok Blocker on, yet tiktok.com, `/@tiktok`,
`/explore` and `/messages` loaded and played. Still's "TikTok stays closed." page never appeared,
and switching the blocker off and on changed nothing. No error was logged anywhere.

The ordinary build from the same commit blocked TikTok. Only builds with `PAID_TIER_ENABLED`
compiled on (paid sandbox QA builds today, V3 Pro store builds later) were affected, on every
browser host: Chrome, Firefox (desktop and Android) and the Safari extension.

## Cause

- TikTok is held on the legacy seed engine on every browser host
  (`FORMAT2_SHIPPING_SERVICES` excludes it), so its block is the seed surface `tt-blocksite`.
- The seed still tags that surface `tier: "pro"`, left over from the retired 1.x paywall in which
  TikTok was a paid service. The V3 model makes it the free `tiktok.all` alias
  (`TIKTOK_ALIAS.tier` in the feature registry).
- The legacy engine's tier gate (`surfaceEnabledForTier` in `rules/engine.ts`) returns early when
  the paid tier is off. Every shipped 2.x build has it off, so the stale tag was invisible. With the
  paid tier on and no Still Pro, the gate dropped the surface: the content script decided `noop`,
  never asked the background for the blocked page, and never drew the in-page block either. The
  background's TikTok route uses the same engine, so it agreed.
- Both CI Playwright lanes build with the paid tier off, so no test ever ran this gate.

The DNR rule sets, the TikTok service worker, the one-time allowance and the content-script
fallback were all checked and were not involved.

## Fix

- `TIKTOK_SITE_SURFACE_ID` (`tt-blocksite`) is free by id in the engine's tier gate, like the
  YouTube Shorts entries in `ALWAYS_FREE_SURFACE_IDS`. Matching by id also covers a fetched rule set
  that still carries the stale tag, which a seed-only retag would not.
- `rules/tiers.ts` counts it as free under the same flag, so the legacy UI does not lock a TikTok
  row in paid builds.
- Both readers sit behind `PAID_TIER_ENABLED`, written so paid-off bundles fold them away.
  `scripts/bundles/identity.mjs` reported byte-identical bundles for the unconfigured, configured
  and store-shaped V3 profiles. The first version, which added the id to the shared set, changed
  every bundle. A constant imported across chunks also stayed exported even after its only use
  folded, so `tiers.ts` names the id by value.

## Prevention

- `scripts/qa/paid-tier-extension.mjs` builds Chrome, Firefox and Safari with the paid tier
  compiled on through a build-only Vite transform (no backend, no source edit). A third CI
  Playwright step runs `tests/playwright/paid-tier-free-outcome.spec.ts` against those builds. The
  spec checks a build marker first, so it cannot pass against a paid-off build.
- Unit tests mock `PAID_TIER_ENABLED: true` for the engine (`paid-tier-free-outcome.test.ts`) and
  the background route (`tiktok-blocked-route-paid-tier.test.ts`).
- When a tier changes, search the rule data (`rules/seed.json`, `rules/format2.json`, any fetched
  copy) for the old tag. Never assume a gate that is dead in shipped builds is correct.

## Verification

- Reproduced with the exact test-set-6 package and with a paid sandbox build of `origin/main`:
  TikTok loaded, against the real site and a fixture. The ordinary build was blocked.
- After the fix, the paid-tier-on Chrome build showed the blocked page on the real tiktok.com, `/`,
  `/@tiktok`, `/explore` and `/messages`. The new spec passes for Chrome and Safari, and the
  real-Firefox `qa-tiktok.spec.ts` passes on the paid-tier-on Firefox build. Without the fix, all
  three fail.

## Related

- [Add paid-tier-only code without changing the shipped bundles](../conventions/add-paid-only-code-without-changing-shipped-bundles.md)
- [Test the production analytics wiring without the seam that satisfies the gate](test-seams-hid-an-analytics-gate-production-never-satisfied.md)
