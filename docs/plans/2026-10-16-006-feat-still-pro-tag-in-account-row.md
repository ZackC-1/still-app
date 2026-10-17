---
title: Show a "Still Pro" tag in the sync card's account row (ISS-0073)
status: in_review
date: 2026-10-16
design: docs/plans/2026-10-16-005-design-apple-signin-before-buy-and-pro-tag.md (section 5, owner-approved 16 Oct)
---

# Show a "Still Pro" tag in the sync card's account row (ISS-0073)

## Intent

After a Still Pro purchase every popup drops the Still Pro card (by design), so nothing in the
popup says the person has Still Pro. The owner approved one minimal signal: a small boxed
**Still Pro** tag in the sync card's account row. No new sentence.

- Signed in: beside the account address.
- Signed out but owning Still Pro (for example an Apple device-local purchase): beside **Sign in**.
- Only while Still Pro is verified as purchased. Never for released-free protection (`protected`
  alone), while access is checking or needs verifying, for a locked offer, or in a paid-off build
  (Pro rows `unsupported`).
- The same on every surface: the desktop popup (Chrome, Firefox desktop, Safari on the Mac), the
  mobile popup (Firefox for Android, Safari on iPhone and iPad) and the shared sync card (browser
  Settings pages and the Apple app).

## Design

- `proPurchased(access)` in `packages/core/src/ui/v3/presentation.ts`: some Pro row is `purchased`
  and none is `checking` or `verification_required`. It reads the real access snapshot that every
  host already passes (browser popups, the Safari popup's App Group access, the Apple app web
  view); no new access source. The offer latch is not used.
- `StillProTag.svelte`: one span with the existing shared `access-tag boxed` style (the settings
  card's "Purchased" tag), so dark mode and text scaling follow the same tokens. Plain text, read
  by screen readers with the address or before the Sign in button.
- `DesktopPopup.svelte`, `MobilePopup.svelte`: account line `address [Still Pro]`; signed out, the
  tag sits in the Sign in group (a small grid keeps Safari's "Opens the Still app" under the button).
- `SyncCard.svelte`: new optional `stillPro` prop; `ExtensionSettings.svelte` and
  `AppleSettings.svelte` pass `proPurchased(access)`.
- `components.css`: `.account-line`, `.account-signin`, `.pro-signin` layout rules only.
- `tests/visual/app/cases/*`: the `STILL_PRO_TAG` deviation on purchased frames.

## Verification

- Red first: `packages/core/src/ui/v3/still-pro-tag.test.ts` (64 cases) failed 15 of 15 positive
  cases on unchanged code (no tag anywhere, `proPurchased` missing); the 49 negative cases passed,
  as guards should. After the change all 64 pass.
- Gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, Playwright fixtures unconfigured
  and configured. Shipped 2.x builds keep the paid tier off, so their Pro rows stay `unsupported`
  and no fixture shows the tag.
- Screenshots of each surface signed in and signed out with Still Pro, rendered from the real
  components at 2x: `docs/release/history/v3/screenshots/iss0073/`.

## Not covered

- Real devices: Safari on the Mac and iPhone, Firefox for Android, and the Apple app need the QA
  steps IOS-47 / MAC-47 / CH-59 / FX-48 on an installed paid sandbox package.
- The design-reference visual harness (`pnpm visual`, on demand, not a CI gate) predates the tag.
  Its purchased frames now declare an owner-approved `STILL_PRO_TAG` deviation so any difference
  is attributed to the sync card; the references themselves are unchanged.
