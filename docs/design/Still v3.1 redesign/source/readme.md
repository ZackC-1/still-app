# Still design system

**Version 3.0.1** (exact version: `--ds-version` in `tokens/spacing.css` and `version` in `tokens/tokens.json`; history in `CHANGELOG.md`). The system gallery and D01 desktop popup were **approved by the owner on 2026-10-02** at 3.0.0. 3.0.1 adds owner-directed corrections without redesigning them. D02 mobile popup, D03 extension settings and D04 Apple app settings were **approved on 2026-10-03** (D04 setup-step wording still to be confirmed).

Still removes distracting video content from social media platforms so that people can **Do what you came to do**. Instagram Reels, Facebook Reels, Youtube Shorts, and TikTok are blocked for free, with no account needed across every supported surface. That means Chrome, Firefox (desktop and Android) and Safari inside the Apple ecosystem (iPhone, iPad, Mac). Optional sign-in gives free settings sync across the surface. Still Pro is once per lifetime payment that adds the Pro controls listed below.

**Sources** (read-only; the reader may not have access)
- Local folder `still-design-system/` (V2 export: README, building-pages.md, tokens, component READMEs, fonts, assets), generated from GitHub `ZackC-1/still-app` @ `claude/keen-carson-4r3bwk@644c2b8`, package `packages/core`.
- The V3 brief (product and scope approved through D524). Where the brief and the V2 export disagree, the brief governs product behaviour.

## Index
- `styles.css`: entry point, @imports only.
- `tokens/`: `fonts.css`, `colors.css` (light/dark + semantic aliases), `spacing.css` (space, radii, sizes, motion, `--ds-version`), `typography.css`, `components.css` (all component classes; wrap UI in `.still-ui`), `tokens.json` (V2 source values).
- `fonts/`: InterVariable.woff2 + OFL license.
- `assets/`: `logos/` (mark, dark mark, wordmark, app icon), `icons/lock.svg`, `services/` (service marks).
- `guidelines/`: foundation specimen cards.
- `components/`: React primitives (below).
- `gallery/`: **V3 review gallery**: popup, settings, access states, consent, purchase/Restore, invitations, owner control, TikTok page, accessibility.
- `ui_kits/still-app/`: V3 screens (all retained V3 screens approved: D01–D04, D12, D14, D18–D20, D24, D25, D28, D41, D43, D45) plus the interim click-through. See its README. Screen scripts use the `.babel` extension and load after `_ds_bundle.js`, so only reusable components and data compile into the library.
- `handoff/`: **build handoff for coding agents**: `HANDOFF.md` (start here), `screens.json` (every frame), `capture.script` and `compare.script` (pixel references and diffing), `previews/` (a PNG of every frame).
- `CHANGELOG.md`: exact versions and approvals.
- `SKILL.md`: Agent Skill wrapper.

## Components
- **controls/**: `Button` (primary, secondary, link, danger-link, danger-solid; block, inline), `Toggle` (default, on-blue, small; 44px hit area; aria-disabled), `TextField`, `OpenSettingsButton`, `Glyph`.
- **brand/**: `Logo`.
- **layout/**: `AppShell` (density, host), `HeroCard`, `ServiceIcon`, `SettingsCard` (+ `AccountLinks`), `Sheet`, `Dialog`.
- **sites/**: `SiteSection`, `SiteList`, `SwitchRow`, plus the data `SiteInventory`, `SiteOrder`, `ProControlList`.
- **access/**: `AccessTag`, `ProOffer`, `RestoreStatus`, `AccountLink`.
- **privacy/**: `ConsentCard`, `SharingSetting`.
- **engagement/**: `Invitation`, `OwnerAllowances`.
- **blocked/**: `TikTokBlocked`.
- **feedback/**: `StatusLine`, `DemoMark`.

**Removed in V3:** `Placeholder` and the placeholder glyph (no in-page replacement for hidden content), `Notice` (default-on sharing with OK/Turn off), `ServiceOptions` (speculative default-on controls), `ServiceCard`/`ServiceList` (replaced by SiteSection/SiteList).

**Intentional additions:** `AppShell`, `AccountLinks` (1:1 with source classes), `Glyph` (one place for the stroke set), `DemoMark` (marks mock-only behaviour), `StatusLine` (one pattern for every real operation state), `Dialog` (confirmations need focus handling that Sheet's form use doesn't cover).

## Control inventory (SiteInventory)
Each site section's header shows only its title ("YouTube Blocker", "Instagram Blocker", "Facebook Blocker", "TikTok Blocker") and its service switch. The free core control is the first row inside: YouTube → Shorts, Instagram → Reels, Facebook → Reels. TikTok keeps one whole-site switch in the header. Free controls start On. Pro controls start Off on new installs; existing users' choices, valid paid rights and protected released-free benefits are kept.
- YouTube: Related videos, End-of-video suggestions, Autoplay prevention, Comments, Live chat.
- Instagram: Stories and Highlights, Suggested accounts, Explore recommendations, Threads links.
- Facebook: Facebook Stories, Videos and Watch, Desktop sidebar ads (legacy id `sidebar_ads`).
- TikTok: one whole-site switch, no expander.

Show what a host can really do. The number of Pro controls is data, never hardcoded copy.

## State model
Three inputs stay separate, and no token color carries any of them:
1. **Saved intention**: the user's choice (`checked`). Global or service Off greys rows (`inactive`/`paused`) and never rewrites them.
2. **Access**: `free`, `protected`, `purchased` are usable. `checking` shows the saved switch disabled with no visible note: no lock, no price (screen readers hear "Checking your Still Pro access"). `verify` (paid offline expiry or rollback) shows the saved switch disabled with no row text; verifying happens from the Still Pro / Restore card; free and protected stay usable. `locked` is only for a Pro control the user is known not to have.
3. **Host capability**: `unsupported` means the host can't do it. There's no switch, and "Your choice is saved." Only Explore and Autoplay have reviewed affected-browser unavailability.

Real operations use `StatusLine` with tones pending, success, failed (+ retry), caution, info. A pending state is never shown as success: "Deletion requested" is not "Deleted", and linking, transfer, purchase and free grant are different outcomes.

## Host adaptations
- **Browser popup** (Chrome, Firefox): compact, 380 wide, under 600 tall. The site list scrolls inside a bounded area, so sync, the settings link and privacy stay reachable at large text. A secondary block **Purchase Still Pro** button sits below the sites when Pro is known not owned (never while checking or verifying, never in Safari) and opens the offer in settings. Browser purchase needs a confirmed Still account and a ready managed channel.
- **Safari popup**: Pro rows not owned show the same right-aligned lock + **Still Pro**; here it opens the Still app (accessible name: "Included in Still Pro. Open the Still app"). When Pro is known not owned, a secondary **See Still Pro** button (in place of Purchase Still Pro) also opens the Still app's Still Pro section, where Apple handles the purchase. No price, Buy or paywall in the popup (Apple guideline 3.1.1). Use the narrower "More settings in Still app" fallback only if Apple actually objects in review.
- **Apple host** (iPhone, iPad, Mac): `AppShell host="apple"` honours safe areas. Type maps to Dynamic Type text styles natively. Buy opens native StoreKit and ratings use native review UI; neither is redrawn.
- **Settings page**: comfortable, 432 column, 320 minimum width. Same compact hero as the popup (title + switch, no body line) and the same global Off behaviour. Rows carry their boundary line.
- **TikTok page**: extension-owned and top-level. On iPhone/iPad Safari, manual instructions replace the settings link.

## Content fundamentals
Plain labels that say what a switch does, short lines that say what stays, and no marketing in the product.

**Approved copy (3.0.0)**
- Site section titles: **YouTube Blocker**, **Instagram Blocker**, **Facebook Blocker**, **TikTok Blocker**. The title alone, with no status line under it.
- First row inside each section is the free core control, named by what it removes: **Shorts** (YouTube), **Reels** (Instagram, Facebook). Pro rows follow: "Related videos", "Stories and Highlights", "Explore recommendations"…
- Rows show just their name. Explanation lines are the exception (only Explore recommendations: "Search stays."); checking and verify rows have no visible note.
- Hero: **Still is active** / **Still is off**, title only, on both the popup and settings.
- Pro rows the user doesn't own: lock + **Still Pro**, right-aligned where the switch would be. Owned and protected rows carry no tag.
- Purchase entry in browser popups: **Purchase Still Pro**. Restore link: **Restore purchase**. Pro list headings: **YouTube Blocking Options**, **Instagram Blocking Options**, **Facebook Blocking Options**.
- Settings offer cards show no price (`showPrice={false}`); the price appears in Apple's purchase sheet or web checkout before payment.
- Offer price line: **One payment. Access forever. No subscription**. No refund wording on the card.
- Sync card: **Settings sync** / "Free. Keep your settings updated across every device and browser" / **Sign in**.
- Popup footer: **Settings** · **Privacy policy**.
- Consent and sharing: one optional combined choice, **Share your email and usage data with Still?** (one-time card, equal **Share** / **Don't share**, approved analytics/AI purposes), then the per-device setting **Share email and usage data** / "Still never tracks or monitors the website you visit". Sign-in and purchase never turn it on. Never call this data anonymous.
- TikTok blocked page: **TikTok stays closed.** / **Open TikTok this time** / **Change this in Still settings**.
- Greyed rows (Still or a site Off) keep their normal line. Never add "Saved as on." or similar notes.

**Rules**
- Sentence case for sentences and buttons; site titles and "Still Pro" keep their capitals. Never all caps.
- Speak to "you"; name the app "Still". Use "we" only in errors: "We couldn't finish checking. Nothing changed."
- Errors say what happened, what still works, and the next step: "Linking didn't finish. Still Pro still works on this device. Try again."
- Uncertainty is stated, not sold: "Checking your Still Pro access." No lock, price or "Purchase Still Pro" while rights are unknown or need verification.
- Privacy lines say what Still never does: "Still never tracks or monitors the website you visit".
- Say "every supported surface", never "everywhere". Mobile means websites in Safari.
- Prices come from verified localized offer data. No trial or count language. Safari shows no price and no purchase button.
- No emoji, no exclamation marks, no scolding, no sentiment gates ("Enjoying Still?"). The tagline "Do what you came to do" is for marketing and store pages, not in-product screens.
- Mock behaviour is marked with `DemoMark`, e.g. "Demonstration only: any 6 digits are accepted". This applies to fake auth, instant deletion, "just now" sync times and fake checkout.

## Visual foundations
- **Color:** one blue (`still-blue` #2a47e8; dark #5a74ff) plus cool neutrals. Blue is scarce: the hero when on, primary buttons, switches when on. Text links use `--link` (dark #6b84ff, 5.25:1 on cards). `--success` and `--caution` are for operation status only; `danger` is for errors and deletion. Access states have no color.
- **Type:** InterVariable only. Titles 700 at -0.02em (hero 25, sheet 22, dialog 20, compact hero 18). Row names 17/600 (compact 15), card titles 15/600, body 16/1.4, switch rows 15 (compact 14), supporting 12–14.5 in `ink-secondary`.
- **Spacing:** 4px base (4, 8, 12, 16, 24, 32, 48). Single column, 432 max, 16 padding, 12 gaps; compact 12 / 8.
- **Radii:** 8 controls, 12 cards, 16 hero, sheets and dialogs, 999 switches and tags.
- **Borders:** hairlines only. Off switches get a 1px `--toggle-off-edge` outline (3:1).
- **Shadows:** flat. Only the switch knob and the float shadow.
- **Backgrounds:** solid fills only. No images, gradients or illustrations.
- **Motion:** switch 160ms, expander 220ms with a 180° chevron, status spinner. `prefers-reduced-motion` removes all of it.
- **Hover / press / disabled:** primary darkens; secondary gets `surface` + `border-strong`; links underline. Primary presses 1px down. Disabled switches are 50% and stay focusable via aria-disabled.
- **Focus:** 2px `focus-ring` at 3px offset (white on the hero).
- **Cards:** `surface-raised`, 12 radius, no border or shadow, one primary action per card, one blue hero per page.
- **Layout order:** no logo app bar on settings or popups (browser and Apple app settings alike) → hero → sites → offer / consent / settings cards → sync/account → footer (popup only).

## Iconography
The brand mark is the balance mark (a ball resting on a line) in `assets/logos`. UI glyphs are the `Glyph` set: lock, chevron, check, alert, clock, spinner, external. Strokes are 1.8px with round caps in `currentColor`, always next to words. Service rows use each service's own mark, never tinted. No icon font, no emoji, no unicode icons.

## Accessibility
- Contrast fixes in V3: dark links 4.43 → 5.25:1; dark hero secondary text 4.44 → 4.90:1 (solid `on-blue`); off-switch track now has a 3:1 outline.
- Switches have a 44px hit area and are labelled by visible text (`labelledBy`/`describedBy`).
- Dialog and Sheet move focus in (Dialog lands on the safe choice), trap Tab, close on Escape and the scrim, and return focus to the opener.
- Minimum widths: popup 380, settings 320. Long localized text wraps and switches never shrink.
- Every UI font size is `calc(Npx * var(--text-scale, 1))`. Large-text specimens set `--text-scale` (1.35, 1.5, 2) with normal layout, never CSS zoom. On Apple, Dynamic Type maps to it natively.

## Owner decisions (review 1)
Accepted as built: service Off greys that site's Pro rows; "Yours to keep" tag on protected rows (purchased rows carry no tag; review 2); bracketed consent purposes until provider text is supplied; calm surface TikTok page; dark hero secondary in full ink. Still open: real localized offer strings, which come only after channel verification. Gallery and D01 approved 2026-10-02.

## Screens
- `ui_kits/still-app/desktop-popup.html` (D01): approved 2026-10-02.
- `ui_kits/still-app/d02-mobile-popup.html` (D02): Safari iPhone/iPad, Firefox Android (illustrative). Approved 2026-10-03.
- `ui_kits/still-app/d03-settings.html` (D03): extension settings page. Approved 2026-10-03.
- `ui_kits/still-app/d04-apple-settings.html` (D04): iPhone, iPad and Mac app settings. Approved 2026-10-03; setup-step wording pending.
- `ui_kits/still-app/d12-apple-onboarding.html` (D12): Apple first launch, four steps. Approved 2026-10-03.
- `ui_kits/still-app/d14-first-run.html` (D14): extension first-run page. Approved 2026-10-03.
- `ui_kits/still-app/d28-rating.html` (D28): rating prompt. Approved 2026-10-03.
- `ui_kits/still-app/store-assets.html` (D41, D43, D45): store images at export size and the icon set. Approved 2026-10-03; Firefox Android image held until support is proven.
- `ui_kits/still-app/d18-purchase.html` (D18–D20, D24, D25): Still Pro view, purchase states, web checkout return, success, Restore. Approved 2026-10-03.
