# Still V3 — release record (curated)

Status: in preparation. All five phase plans approved (G1/D520, G2/D521,
G3/D522, G4/D523, G5/D524); execution authorized under D525. D526–D542 are
recorded in the local-only decision log; D543 is below. Next decision ID: D544. No application, store, payment, or production changes are claimed by
this record — it curates local-only preparation into committed docs.

V3 keeps the free core and adds an optional one-time-purchase Pro tier. The
[strategy](../../../../STRATEGY.md), [product specification](../../../PRODUCT.md), and
[architecture](../../../ARCHITECTURE.md) distinguish shipped 2.x from V3 preparation.
The V3 decision does not change existing 2.x artifacts or enable paid behavior by itself.

## Product contract (settled)

- Free core: YouTube Shorts, Instagram/Facebook Reels removal, TikTok website
  blocking, optional free settings sync. No account required.
- Still Pro: twelve optional extras, fresh installs Off — YouTube Related
  videos, end-of-video suggestions, autoplay prevention, comments hiding, live
  chat hiding; Instagram Explore, Stories/Highlights, suggested accounts,
  Threads links; Facebook Stories, Videos, desktop sidebar ads and sponsored posts in the phone feed (one `facebook.sponsored` extra).
- Price: $9.99 US base, one-time lifetime, one launch offer. No subscription,
  trial, or price experiments.
- Web refund: seven-day voluntary full-refund request window. Apple purchases
  follow Apple's refund process.
- Existing rights: verified legacy payments map to frozen Pro; zero/free-era
  use maps to frozen released-free protection.

Curated from the local-only commercial package and decision summary; see
"Raw records" below for the full sources.

## Key contract deltas vs v2

- Sync: authenticated baseRevision/localStep, independent fields, one atomic
  writer, account fences, conservative first-link/CAS repair.
- Purchase: on Apple, sign-in is offered first and can always be skipped
  ("Buy without an account"); a purchase started signed in links to that
  account automatically, and accountless holders keep explicit optional
  linking (D543). Verified ownership/Restore/dual-auth transfer; Restore never
  needs sign-in; web checkout only through an enforceably managed provider.
- Paid offline: signed 30-day deadlines, revocation/expiry latches, clock
  rollback safeguards; no DRM or fingerprinting.
- Analytics: the current permission, identity and closed-event rules are in
  [ADR 0004](../../../adr/0004-first-party-usage-analytics.md#v3-consent-2026-10-10).
  The October 10 and 12 decisions supersede the original combined-consent proposal.
- AI: dashboard assistance and five scouts On, training Off; customer analysis
  only after consented eligible inputs and deletion/expiry are proven.
- Rating: owner-controlled, initially Off; no rating analytics.
- Deferred/removed: counting/history/summary, Edge, native Android/Play,
  Firefox on Android (deferred to a later update on 20 Oct 2026; code paths kept), trials, desktop sponsored-feed detection, non-TikTok placeholders.

## Apple sign-in before buying (D543, 16 October 2026)

Owner decision D543 (ISS-0071, option B): signed out, Get Still Pro in the iPhone and Mac apps
opens the email-code sign-in first, with "Sign in first, so Still Pro stays with your account." and
a "Buy without an account" link. A successful sign-in continues to Apple's sheet without a second
tap, and the verified purchase links to that account through the existing guarded link. Cancelling
opens no Apple sheet. Restore and accountless purchase stay fully supported (Guideline 5.1.1(v)).
Accountless holders see "Sign in to keep Still Pro with your account." with Sign in and Not now.
See [ADR-0005](../../../adr/0005-apple-still-pro-purchase-starts-with-sign-in.md) and the
[design note](../../../plans/2026-10-16-005-design-apple-signin-before-buy-and-pro-tag.md).

## Mobile Pro amendment (8 October 2026)

The owner requires all twelve extras on Safari and Firefox Android and approved
sponsored-post hiding in the Facebook phone feed as the mobile behavior of
`facebook.sponsored`. Desktop sidebar behavior remains. This is an approved
implementation requirement; structural and physical-device acceptance is pending.
See [the bounded implementation plan](../../../plans/2026-10-08-feat-mobile-pro-completion.md).
Source status (9 October, not device-accepted): macOS Safari offers all twelve; iPhone/iPad Safari
and Firefox for Android offer nine (end-of-video suggestions and live chat have no phone-layout
surface; the phone-feed sponsored behavior is blocked on the owner's Facebook session).

Owner decision, 20 Oct 2026: the first V3 release ships Chrome, Firefox desktop and the Apple apps.
Firefox on Android is deferred to a later update; its Pro parity work stays in the code.

## Design

- Existing Claude Design system update approved; D01 desktop popup approved
  (D530). Remaining screens keep their review gates.
- D531 originally specified combined email/usage consent. Its prompt requirement was superseded
  by [ADR 0004's later V3 decisions](../../../adr/0004-first-party-usage-analytics.md#one-usage-data-control-2026-10-12).
  Use that record for the current settings switch and identity disclosures.
- Handoffs (local-only): `DESIGN-HANDOFF-V3.0.1.md`, `DESIGN-HANDOFF-V3.1.md`;
  reference archives `still-design-system-v3.0.1/v3.1` with extraction receipts.

## Build plan (local-only source)

- `BUILD-PLAN.md`: 20 PR ownership units with dependency and verification
  contracts; `BUILD-PLAN.json` is the exact catalogue.
- Technical contracts: sync ordering/authority/repair, purchase proof and
  paid offline continuity (D519), consent/attribution/erasure/AI, rating
  operation.
- Execution receipts: `execution/20261002-native/`, `execution/20261005-claude/`.

## Raw records (local only, never committed)

Full preparation lives in Git-ignored `docs/build/v3/` at the repo root:
`BUILD-PLAN.md/.json`, `DECISION-LOG.md` (D001–D490+), `STATE.md`,
`COMMERCIAL-DECISION-PACKAGE.md`, `DECISION-SUMMARY.md`, phase/homework
records, and the paused homework handoff
`docs/handoffs/build/2026-10-01-codex-personal-v3-homework-pause.md`
(resumes at S05/H037, RevenueCat purchase-cohort count). These paths are
absent from GitHub by design; transfer them securely between machines, never
through commits.

## Screenshots

- Committed: [store-ready/](../../screenshots/store-ready/README.md) per-store
  finals; [source/v3/](../../screenshots/source/v3/assets.json) render tooling.
- Local only: `build/v3/still-design-system-v3.2/handoff/` reference PNGs and
  screen previews; `design-review/` and `design-review-v3.1/` captures.

## Release files

No V3 store packages exist yet — nothing under `release-builds/` for V3, and
no submission is claimed. When built, packages land per version in the
Git-ignored `release-builds/` (local only), same as v2.
