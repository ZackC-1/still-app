---
title: Turning the paid tier on revived retired 1.x tier tags and left TikTok open
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
browser host: Chrome, Firefox (desktop and Android) and the Safari extension. The same gate also
dropped Instagram and Facebook Reels on any page that ran the legacy lane.

## Cause

- TikTok is held on the legacy seed engine on every browser host
  (`FORMAT2_SHIPPING_SERVICES` excludes it), so its block is the seed surface `tt-blocksite`.
- The seed tags every Instagram, Facebook and TikTok surface `tier: "pro"`. That is left over from
  the retired 1.x paywall, in which those three services were paid. Under V3 (D514) every seed
  surface is a free outcome: YouTube Shorts, the Instagram and Facebook Reels core
  (`instagram.reels`, `facebook.reels`), and the free `tiktok.all` alias (`TIKTOK_ALIAS.tier`). The V3
  Still Pro extras exist only in the format-2 rule set, which takes its tiers from the feature
  registry.
- The legacy engine's tier gate (`surfaceEnabledForTier` in `rules/engine.ts`) returns early when
  the paid tier is off. Every shipped 2.x build has it off, so the stale tags were invisible. With the
  paid tier on and no Still Pro, the gate dropped the surfaces. For TikTok the content script
  decided `noop`: it never asked the background for the blocked page and never drew the in-page
  block. The background's TikTok route uses the same engine, so it agreed. Instagram and Facebook
  use the format-2 lane once settings are schema 2. But any page on the legacy lane (settings not
  yet written on a first visit, or unreadable) lost Reels removal too. Their hide CSS sits in the
  packaged Pro stylesheet, which the content script only switched on for Still Pro.
- Both CI Playwright lanes build with the paid tier off. Fixture tests even pinned the 1.x
  behaviour ("Reels stay for a free user when the paid tier is on").

The DNR rule sets, the TikTok service worker, the one-time allowance and the content-script
fallback were all checked and were not involved.

## Fix

Audit of every seed entry tagged "pro" (`rules/seed.json`): all 15 are free outcomes in V3, none
is a Still Pro extra.

| Service | Seed surfaces | V3 outcome |
|---|---|---|
| Instagram | `ig-reels-url`, `ig-nav`, `ig-inline`, `ig-explore-search`, `ig-suggested`, `ig-profile-tab` | Reels core, free |
| Facebook | `fb-reel-url`, `fb-feed`, `fb-feed-shelf`, `fb-left-menu`, `fb-page-tabs`, `fb-mobile-tabs`, `fb-watch`, `fb-search-groups`, `fb-suggested` | Reels core, free |
| TikTok | `tt-blocksite` | `tiktok.all`, free |

YouTube's seed surfaces were already tagged free. `format2.json` carries no tier field.

- `FREE_OUTCOME_SURFACE_IDS` in `rules/engine.ts` lists those 15 ids. The tier gate treats them as
  free, alongside the YouTube entries in `ALWAYS_FREE_SURFACE_IDS`. Matching by id also covers a
  fetched rule set that still carries the stale tags, which retagging the seed alone would not.
- The content script switches the packaged Pro stylesheet (the seed's "pro" hide rules, all of them
  Reels) on for everyone when the paid tier is on.
- `rules/tiers.ts` reports every legacy service as free when the paid tier is on, so the legacy UI
  locks no row.
- A unit test fails if a new seed surface is neither free nor deliberately classified.
- Every reader sits behind `PAID_TIER_ENABLED` and is written so paid-off bundles fold it away
  (the flag leads each `||`; the set is `/* @__PURE__ */`; `tiers.ts` imports no new constant).
  `scripts/bundles/identity.mjs` reported byte-identical bundles for the unconfigured, configured
  and store-shaped V3 profiles. A first attempt that added an id to the shared set changed every
  bundle. A constant imported across chunks also stayed exported even after its only use folded.

## Prevention

- `scripts/qa/paid-tier-extension.mjs` builds Chrome, Firefox and Safari with the paid tier
  compiled on through a build-only Vite transform (no backend, no source edit). A third CI
  Playwright step runs `paid-tier-free-outcome.spec.ts` (checks a build marker first, so it cannot
  pass against a paid-off build), `tiktok-blocked.spec.ts`, `fixtures.spec.ts` (legacy lane) and
  `fixtures-format2.spec.ts` (format-2 lane) against those builds. That covers the free outcome on
  all four services in both lanes without Still Pro.
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
