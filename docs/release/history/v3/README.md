# Still V3 — release record (curated)

Status: in preparation. All five phase plans approved (G1/D520, G2/D521,
G3/D522, G4/D523, G5/D524); execution authorized under D525. Next decision ID:
D526. No application, store, payment, or production changes are claimed by
this record — it curates local-only preparation into committed docs.

V3 keeps the free core and adds an optional one-time-purchase Pro tier. This
supersedes the "free, paid flags disabled" posture the current canonical docs
still describe; Step 3 of the docs refresh carries these decisions into
`STRATEGY.md`, `docs/PRODUCT.md`, and `docs/ARCHITECTURE.md`.

## Product contract (settled)

- Free core: YouTube Shorts, Instagram/Facebook Reels removal, TikTok website
  blocking, optional free settings sync. No account required.
- Still Pro: twelve optional extras, fresh installs Off — YouTube Related
  videos, end-of-video suggestions, autoplay prevention, comments hiding, live
  chat hiding; Instagram Explore, Stories/Highlights, suggested accounts,
  Threads links; Facebook Stories, Videos, sidebar ads.
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
- Purchase: no Apple account wall, explicit optional linking, verified
  ownership/Restore/dual-auth transfer; web checkout only through an
  enforceably managed provider.
- Paid offline: signed 30-day deadlines, revocation/expiry latches, clock
  rollback safeguards; no DRM or fingerprinting.
- Analytics: fresh optional combined email/usage/AI consent; 42 retained
  closed events; no browsing/URL/search/video/replay/autocapture.
- AI: dashboard assistance and five scouts On, training Off; customer analysis
  only after consented eligible inputs and deletion/expiry are proven.
- Rating: owner-controlled, initially Off; no rating analytics.
- Deferred/removed: counting/history/summary, Edge, native Android/Play,
  trials, sponsored-feed detection, non-TikTok placeholders.

## Design

- Existing Claude Design system update approved; D01 desktop popup approved
  (D530). Remaining screens keep their review gates.
- D531 correction stands: one fresh optional combined email/usage consent;
  any export claiming no-email or anonymized-only is superseded.
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
