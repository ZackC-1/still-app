# Still design system: versions

The exact version lives in `tokens/spacing.css` (`--ds-version`) and `tokens/tokens.json` (`version`). Download/ZIP names are not a version record.

## 3.0.1 (2026-10-02)
**D02 mobile popup, D03 extension settings and D04 Apple app settings approved by the owner on 2026-10-03.** D04 decisions: single centred column on iPad and Mac; Sign in matches D03's primary button; sync above Still Pro; combined "Still Pro and sync" card for owners; no price on the offer card. Setup-step wording pending owner confirmation. Post-approval owner edit (2026-10-03): logo removed from the top of D04 settings. D03 changes before approval: compact hero, no logo, Settings sync above Still Pro, one "Still Pro and sync" card for owners, offer card with a single "Get Still Pro" button and no control list. Post-approval owner edit (2026-10-03): price removed from the D03 and D04 offer cards; Apple's sheet and web checkout show it before payment.
Owner-directed corrections and handoff fixes on top of approved 3.0.0. No visual redesign of approved screens.
- Consent restored to the brief's single combined email-plus-usage choice (ConsentCard, SharingSetting defaults, gallery, guidance). The 3.0.0 "anonymized" wording is withdrawn: it made an unsupported anonymity claim.
- Real text scaling: every UI font size is `calc(Npx * var(--text-scale, 1))`. Large-text specimens use `--text-scale` with normal layout, not CSS zoom.
- Review screens (gallery, D01–D04, interim kit) load their own `.babel` scripts after the bundle. Only reusable components and data compile into `_ds_bundle.js`.
- `tokens/tokens.json` regenerated from the V3 CSS.
- UI kit README refreshed.
- New screens D02 mobile popup, D03 extension settings, D04 Apple app settings (approved 2026-10-03, see above).
- Safari popups: secondary "See Still Pro" button opens the Still app (no price, no Buy) when Pro is known not owned.
- Owner copy edits: row explanation lines removed (except Explore recommendations: "Search stays."); no visible notes on checking/verify rows (screen-reader text kept); "Yours to keep" tag removed; "Restore purchase"; Pro list headings "<Site> Blocking Options"; Safari offer body "These controls are included in Still Pro."; TikTok page shows only "TikTok stays closed." and its actions; link card copy shortened; owner allowance rows without sub-lines; brand cover tagline removed.

- New screens D12 Apple onboarding and D14 extension first-run: **approved by the owner on 2026-10-03** as built (consent asked during onboarding, pinning step kept, headlines and welcome line as shown). Sync line corrected to "every device and browser".
- New screen D28 rating prompt: **approved by the owner on 2026-10-03** as built (between sites and sync card, popup only). Copy: "Rate Still" / "A rating helps other people find Still." / "Not now".
- New: D41/D43/D45 store images and icon set: **approved by the owner on 2026-10-03** as built (flat Still Blue, three-image story, existing icon artwork). Firefox Android image held until support is proven.
- New: D18–D20, D24, D25 purchase and Restore screens: **approved by the owner on 2026-10-03** as built. No price on the Still Pro view; no refund wording on Still screens (checkout and receipt only); return headline "Thanks for purchasing Still Pro"; no Buy while Restore is checking, verifying or failed.
- All retained V3 design-now screens are approved. Open items: setup-step wording (owner to confirm), consent purpose text, support address, verified localized offer strings.
- Build handoff added: `handoff/HANDOFF.md`, `screens.json`, `capture.script`, `compare.script`, previews of every frame.

## 3.0.0 (2026-10-02)
V3 system: site sections, access states, Still Pro offer, Restore, linking, consent, invitations, owner rating control, TikTok blocked page, contrast and focus fixes. **System gallery and D01 desktop popup approved by the owner.** Owner copy edits applied (Blocker titles, Shorts/Reels rows, lock + Still Pro, Purchase Still Pro, price line, Settings footer, sync line).

## 3.0.0-review.1
First V3 review build.
