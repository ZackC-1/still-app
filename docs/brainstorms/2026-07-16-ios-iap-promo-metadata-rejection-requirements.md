---
date: 2026-07-16
topic: ios-iap-promo-metadata-rejection
---

# iOS 2.3.2 rejection remediation — promoted-IAP image + full resubmission bundle

## Summary

Clear the July 16 iOS rejection (submission `d8784a58-c287-4c86-bc2c-247a4690a86b`, version 1.0
build 3) by replacing the promoted `still_sync` ("Still Pro") promotional image with compliant v3
brand artwork generated from the existing render pipeline, scrubbing price references from the
promoted-IAP metadata, and completing the already-planned resubmission bundle: deploy the
`review-signin` Edge Function, set the reviewer secrets, rebuild the Apple archives with
`VITE_REVIEW_SIGNIN_EMAIL`, and update the App Review notes.

---

## Problem Frame

Apple's July 16 review of iOS 1.0 (3) raised two findings, both Guideline 2.3.2 (Accurate
Metadata) and both about the promotional image on the promoted `still_sync` in-app purchase:
(a) the image is a screenshot taken from the app with text too small to read, and (b) the image
references the IAP's price.

App Store Connect almost certainly still hosts the original v1 image — a paywall screenshot with
a visible "$1.99". The repo already contains a brand-safe v2 replacement
(`docs/release/screenshots/store-ready/apple/still-pro-iap-v2-1024x1024.jpg`, rendered July 13 by
`docs/release/screenshots/source/promo.html` + `render.mjs`) that was never uploaded — the
runbook checkpoint "visually confirm the brand-safe promotional image saved" is still unchecked,
and `docs/release/01-apple-app-store.md` §7 currently instructs deleting the image rather than
replacing it. The v2 art itself would partially re-expose the "small text" finding: its subline
("One purchase. Every supported screen.") renders small relative to the canvas.

Independently, the 2.1(a) OTP-error defenses built for the last rejection are merged but not
live: `review-signin` is absent from the six functions deployed to the hosted Supabase project,
the `REVIEW_SIGNIN_*` secrets are unset, and `packages/app-webview/.env` (dated June 24) predates
`VITE_REVIEW_SIGNIN_EMAIL` — so the current archives contain no review branch. Resubmitting
metadata alone would leave the reviewer one sign-in attempt away from a repeat 2.1(a).

---

## Key Decisions

- **Replace the promotional image; do not delete it.** Keeps Still Pro promoted and discoverable
  on the App Store. Supersedes the "delete the IAP promotional image" step in
  `docs/release/01-apple-app-store.md` §7.
- **Generate v3 through the existing `promo.html`/`render.mjs` pipeline.** Reuse the established
  pattern rather than hand-crafting an asset; the compliant design becomes reproducible source,
  not a one-off export.
- **Full-bundle resubmission.** Apple's metadata-rejection flow would allow fixing the image and
  resubmitting build 3 without a new binary, but the bundle (review-signin live + archive with
  the review env) is deliberately included to close the 2.1(a) recurrence risk before the
  reviewer's next sign-in attempt.
- **v3 design constraints come from Apple's published spec.** 1024×1024, PNG or high-quality
  JPEG; unique artwork, not a screenshot, not confusable with the app icon; no overlay-text
  reliance and nothing price-shaped; critical content kept out of the lower-left corner (Apple
  composites the app icon there in search placements); must read clearly at small sizes.

---

## Requirements

**Promoted-IAP metadata (the two 2.3.2 findings)**

- R1. A v3 promotional image exists under `docs/release/screenshots/store-ready/apple/`,
  1024×1024, produced by the repo render pipeline, satisfying all v3 design constraints: unique
  brand artwork, no app screenshot, no price text anywhere, text limited to large brand/product
  wording (no sentence-length copy), lower-left corner free of essential content, and visually
  distinct from the app icon.
- R2. The promoted `still_sync` metadata carries no price references: display name ≤30
  characters, description ≤45 characters, neither mentioning price; the exact App Store Connect
  fields to verify are documented in the runbook.
- R3. `docs/release/screenshots/store-ready/README.md` names v3 as the only uploadable IAP image
  and records the compliance rules (no screenshot, no price, no small text, lower-left safe zone)
  so a future upload cannot regress to v1/v2.
- R4. `docs/release/01-apple-app-store.md` §7 replaces the image-deletion step with the
  replacement flow: exact ASC navigation (Apps → Still → Monetization → In-App Purchases →
  `still_sync` → App Store Image → Choose File), the note that promoted-IAP metadata is reviewed
  with the open submission and a metadata rejection needs no new binary, and the ~24h propagation
  caveat for promoted-IAP changes.

**Review-signin resubmission bundle (2.1(a) recurrence defense)**

- R5. The `review-signin` Edge Function is deployed to hosted project `kikpgrreradotvvefdgd`
  (fail-closed before secrets exist, so deploy order is safe).
- R6. `REVIEW_SIGNIN_EMAIL` and `REVIEW_SIGNIN_CODE` secrets are set on the hosted project with
  the values from the private submission record; the values never appear in any committed file.
- R7. `packages/app-webview/.env` gains `VITE_REVIEW_SIGNIN_EMAIL` equal to the
  `REVIEW_SIGNIN_EMAIL` secret exactly (the §1c cross-check in
  `docs/release/extension-purchase-deploy-checklist.md`), and the archive-rebuild steps for both
  Apple platforms are documented against `apps/apple/scripts/archive.sh`.
- R8. The §1b hosted-config hard gates are verified against the live project (custom SMTP active;
  BOTH "Magic Link" and "Confirm signup" templates contain `{{ .Token }}` and no
  `ConfirmationURL`/`TokenHash`; `otp_length` 6; expiry 3600; 60s resend) and the results
  recorded honestly in the checklist.
- R9. The post-deploy smoke gates run before upload: one real-inbox OTP sign-in with a non-review
  address, one fixed-code sign-in with the review address; on-device portions are flagged
  human-gated rather than claimed.
- R10. App Review notes per the §7 template are finalized for iOS with the review address and
  fixed code filled from the private submission record, plus a short note that the promotional
  image was replaced with original brand artwork.

**Classification and handoff**

- R11. Every remediation step is classified as one of: repo-code (agent), CLI-automatable
  (agent), ASC-portal (human), or on-device (human), and the human steps are delivered as
  precise, ordered, click-level instructions in the existing runbooks — not a new parallel doc.

---

## Acceptance Examples

- AE1. **Covers R1.** Given the render pipeline runs, when v3 is produced, then the file is
  exactly 1024×1024, contains no "$", "1.99", "price", or per-item small copy, and a visual check
  confirms only large brand/product text on original artwork with an empty lower-left zone.
- AE2. **Covers R6, R7.** Given the secrets are set and `.env` updated, when the §1c cross-check
  compares `VITE_REVIEW_SIGNIN_EMAIL` with the deployed `REVIEW_SIGNIN_EMAIL`, then they match
  byte-for-byte and the check result is recorded.
- AE3. **Covers R2.** Given the ASC promoted-IAP fields are reviewed, when display name and
  description are read, then neither contains a currency symbol, numeral price, or the word
  "free"/"$1.99"-style claim, and both fit 30/45 characters.

---

## Scope Boundaries

- No app source-code changes: the review-signin client wiring
  (`packages/app-webview/src/main.ts`) is already merged; only env values, assets, and docs move.
- App screenshots stay as submitted — the third-party-service-mark risk in
  `docs/release/screenshots/store-ready/README.md` remains open and is not this effort.
- No new promoted placements, win-back offers, or additional IAPs; only the existing
  `still_sync` image and metadata.
- Browser-store tracks (Chrome 1.0.1 live, AMO 1.0.2 in review) untouched.
- On-device sandbox validation (`docs/release/VALIDATION.md` items 1–8) and the ASC portal
  actions are human-gated; this effort prepares and documents them but cannot execute them.

---

## Dependencies / Assumptions

- **Assumption (unverifiable from the repo):** ASC currently hosts the v1 screenshot-with-price
  image. The rejection text matches v1, not the in-repo v2. If ASC turns out to host v2, the v3
  replacement still resolves both findings (v3 removes the small-text exposure).
- The Supabase CLI is authenticated against `kikpgrreradotvvefdgd` (verified: six functions
  listed; `review-signin` absent).
- The review address and fixed code exist in the private submission record from July 15; they are
  inputs, not repo content.
- The same 1.0 version train accepts a replacement build (rejected versions do); the exact next
  build number is confirmed during planning against the Xcode project and ASC upload history.

---

## Outstanding Questions

**Deferred to planning**

- Next Apple build number: re-archive as build 4 (if 4 was never uploaded) or bump to 5 — check
  `apps/apple` project settings and ASC's TestFlight/build list.
- v3 pipeline mechanics: extend `promo.html` with a v3 IAP variant while keeping v2 output
  reproducible, or version the scene parameters; and whether `render.mjs` should skip the
  unrelated screenshot targets on this run.
- Whether the macOS resubmission notes need any iOS-specific divergence beyond platform names.

---

## Sources

- Rejection screenshots: submission `d8784a58`, reviewed 2026-07-16 on iPad Air 11-inch (M3),
  version 1.0 (3); both findings Guideline 2.3.2 against the promoted-IAP promotional image.
- Apple, "Promoting your In-App Purchases" — image spec (1024×1024 PNG/JPEG), no-screenshot rule,
  auto-framing + lower-left app-icon composite, small-size scaling guidance:
  developer.apple.com/app-store/promoting-in-app-purchases/
- Apple, ASC Help "Promote In-App Purchases" — exact UI navigation; promoted metadata independent
  of app version; ~24h propagation: developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/promote-in-app-purchases/
- Apple, ASC Help "In-App Purchase information" — display name ≤30 / description ≤45:
  developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/in-app-purchase-information/
- Apple, ASC Help "Reply to App Review messages" — metadata rejection resubmits the same build;
  submission stays open: developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/reply-to-app-review-messages/
- Repo: `docs/release/screenshots/source/promo.html`, `docs/release/screenshots/source/render.mjs`
  (asset pipeline); `docs/release/01-apple-app-store.md` §6–§7 (runbook);
  `docs/release/extension-purchase-deploy-checklist.md` §1b–§1c (hard gates);
  `docs/release/VALIDATION.md` (on-device checklist); `packages/app-webview/src/main.ts` (review
  wiring); root `.env.example` (env documentation).
- Note: Apple's published text nowhere explicitly bans price in the promotional image — the ban
  is enforced in practice (this rejection) via 2.3.2/2.3.1; treat "no price anywhere in promoted
  metadata" as a hard rule regardless.
