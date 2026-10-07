# Still V3: build handoff for coding agents

Design system **3.0.1**. Every screen listed below is **approved by the owner** (2026-10-02/03). Build them so that a Chromium screenshot of your implementation matches the reference within 0.5% of pixels.

## 1. Source of truth, in order
1. **Reference pages** (live HTML rendering the real components). These are exact: open them, inspect them, copy values from them.
2. **`tokens/*.css`**: every color, size, radius, font size and component class. Copy verbatim.
3. **`components/**/<Name>.jsx` + `.d.ts`**: markup structure, class names, props, copy strings and state logic.
4. **`readme.md`**: content rules, state model and host rules. **`CHANGELOG.md`**: every owner decision.
5. **PNG references** in `handoff/reference/` (generate them, section 3). `handoff/previews/` holds scaled-to-fit previews of every frame, to orient by; don't diff against them.

If any of these disagree, the higher item wins. Never round values: if a token says 12.5px, use 12.5px.

## 2. View the reference pages
The pages need to be served over HTTP; opening the files directly from disk won't load them.
```
npx serve .        # from the design-system root
```
| Screen | Page | Frames are composed in |
|---|---|---|
| System gallery | `gallery/index.html` | `gallery/*.babel` |
| D01 desktop popup | `ui_kits/still-app/desktop-popup.html` | `DesktopPopup.babel` |
| D02 mobile popup (Safari iPhone/iPad, Firefox Android) | `ui_kits/still-app/d02-mobile-popup.html` | `MobilePopup.babel` |
| D03 extension settings | `ui_kits/still-app/d03-settings.html` | `SettingsPage.babel` |
| D04 Apple app settings | `ui_kits/still-app/d04-apple-settings.html` | `AppleSettings.babel` |
| D12 Apple onboarding | `ui_kits/still-app/d12-apple-onboarding.html` | `AppleOnboarding.babel` |
| D14 extension first-run | `ui_kits/still-app/d14-first-run.html` | `FirstRun.babel` |
| D18–D20, D24, D25 purchase and Restore | `ui_kits/still-app/d18-purchase.html` | `Purchase.babel` |
| D28 rating prompt | `ui_kits/still-app/d28-rating.html` | `Rating.babel` |
| D29 TikTok blocked page | `components/blocked/blocked.card.html` + gallery | `TikTokBlocked.jsx` |
| D41, D43, D45 store images and icons | `ui_kits/still-app/store-assets.html` | `Store.babel` |

`handoff/screens.json` lists every page, section and frame with its caption, device kind, width, height, theme, safe areas and text scale. Each frame's exact props (access states, values, open section, signed-in, sync state) are in its `.babel` file next to the same caption.

## 3. Generate pixel references, then compare
```
npm i -D playwright pngjs pixelmatch && npx playwright install chromium
node --input-type=module - < handoff/capture.script     # -> handoff/reference/<screen>/<nn>-<caption>.png (2x)
node --input-type=module - handoff/reference/<screen>/<file>.png your-shot.png diff.png < handoff/compare.script
```
- The scripts use a `.script` extension so the design-system compiler leaves them alone; copy them to `.mjs` if you prefer `node handoff/capture.mjs`.
- `capture.script` takes element screenshots of every device frame and every store asset at its exact export size (the store assets are reset to 1:1 first).
- To compare your build, render the same state in Chromium at deviceScaleFactor 2, with the same width, theme (`data-theme`) and `--text-scale`. Screenshot the same element, then run the compare script. It exits non-zero above 0.5%. Fix until it passes.
- Compare Chromium against Chromium on the same OS; font rasterisation differs between engines.

## 4. Rules that make pixels match
- **Font:** `fonts/InterVariable.woff2` through `tokens/fonts.css`. Root `.still-ui` sets `font-optical-sizing: auto`, `-webkit-font-smoothing: antialiased` and `text-rendering: optimizeLegibility`. No fallback font in screenshots.
- **Box model:** `.still-ui` and all its descendants are `box-sizing: border-box`.
- **Type scale:** every font size is `calc(Npx * var(--text-scale, 1))`. Default 1. Apple hosts map Dynamic Type to it; the reference large-text frames use 1.35, 1.5 and 2.
- **Theme:** light on `:root`; dark from `prefers-color-scheme`, or forced with `data-theme="dark"` on any ancestor. Use semantic tokens (`--ink`, `--surface-raised`, `--link`…), never hex in components.
- **Geometry:**
  - Popups are 380 wide (compact density) and capped by `--popup-max-block-size` (600 desktop). Only `.site-scroll` shrinks.
  - The settings column is 432 max, 320 min, comfortable density.
  - Dialogs are 360 max; sheets 420.
- **Controls:**
  - Switch: 52×31, or 40×24 small, with a 44px hit area and a 1px `--toggle-off-edge` outline when off.
  - Block buttons are at least 44px tall. Inline primary buttons don't wrap.
  - Focus ring: 2px `--focus-ring` at 3px offset; white on the blue hero.
- **Radii:** 8 controls, 12 cards, 16 hero, sheets and dialogs, 999 switches and tags. Flat: no shadows except the switch knob.
- **Icons:**
  - UI glyphs: `Glyph` paths (1.8px stroke, round caps, `currentColor`).
  - Service marks: `components/layout/serviceIconData.js` / `assets/services`.
  - Brand: `assets/logos`.
  - No icon fonts or emoji.
- **Motion:** switch 160ms; expander 220ms `cubic-bezier(0.4,0,0.2,1)`. Everything stops under `prefers-reduced-motion`. Capture screenshots with animations disabled.
- **Copy:** use the strings in the components and `readme.md` → Content fundamentals exactly as written. Owner-approved wording is deliberate; don't "fix" it.

## 5. Component map (React reference → build target)
The app is Svelte 5. Rebuild each React component as a Svelte component using the **same class names** from `tokens/components.css`, so the CSS applies unchanged.

| Component | File | Classes |
|---|---|---|
| AppShell | `components/layout/AppShell.jsx` | `.still-ui .app[data-density][data-host]` |
| HeroCard | `components/layout/HeroCard.jsx` | `.hero(.off)(.compact)` |
| SiteList / SiteSection | `components/sites/SiteSection.jsx` | `.service-group .site-scroll .services`, `.service-row`, `.service-options(.open)` |
| SwitchRow | `components/sites/SwitchRow.jsx` | `.option-row[data-access][data-inactive]`, `.lock-pro` |
| SiteInventory | `components/sites/SiteInventory.js` | data: ids, labels, defaults, order |
| Toggle | `components/controls/Toggle.jsx` | `.toggle(.on)(.on-blue)(.small)` |
| Button | `components/controls/Button.jsx` | `.primary .secondary .link .danger-solid (.block)(.inline)` |
| Glyph | `components/controls/Glyph.jsx` | inline SVG paths |
| SettingsCard / AccountLinks | `components/layout/SettingsCard.jsx` | `.card .card-stack .setting-row .sync-row .account` |
| Sheet / Dialog | `components/layout/Sheet.jsx`, `Dialog.jsx`, `useModalFocus.js` | `.scrim .sheet .dialog` (focus trap, Escape, return focus) |
| ProOffer / RestoreStatus / AccountLink / AccessTag | `components/access/*` | `.offer-*`, `.access-tag` |
| ConsentCard / SharingSetting | `components/privacy/*` | `.choice-actions .purpose-list` |
| Invitation / OwnerAllowances | `components/engagement/*` | `.inline-actions .allow-*` |
| TikTokBlocked | `components/blocked/TikTokBlocked.jsx` | `.blocked .blocked-actions` |
| StatusLine / DemoMark | `components/feedback/*` | `.status-line[data-tone]`, `.demo-mark` |

The screen-only layouts used by D12, D14 and D18 (`.ob*`, `.steps/.step`, `.fr*`) live in `ui_kits/still-app/review.css`. Move them into your app's styles with the same values. The device frames (`.r-device`, `.r-tabbar`, `.r-titlebar`, `.r-home`) are review chrome only; don't build them.

## 6. Behaviour that screenshots can't show
- **Sites:**
  - At most one section is open; a fresh install starts collapsed. The last open section is remembered locally only.
  - Service or global Off greys the rows and never rewrites saved choices.
- **Access:** saved choice, purchase rights and host capability are separate inputs (`readme.md` → State model).
  - Checking, verify or a failed check means no Buy button anywhere.
  - Locked applies only when Pro is known not to be owned.
- **Safari:**
  - No price and no Buy in the Safari popup. "See Still Pro" and the lock rows open the Still app.
  - Apple purchase and review prompts are native StoreKit/review UI. Never draw them.
- **Browser purchase:** needs a confirmed Still account. "Get Still Pro" signs the user in first, then opens provider checkout in a new tab and returns to the D20 page, which confirms with the server before showing success.
- **TikTok:** "Open TikTok this time" allows the current tab only, after the confirmation dialog. It's not saved and not synced.
- **Invitations:** at most one card. Sync and linking come before rating. Never during setup, consent, errors, purchase or Restore.
- **Rating:** once per install, after at least 7 days and 3 separate days of use, and only with the owner allowance on.
- **Consent:** one combined email-plus-usage choice with equal Share / Don't share buttons and a per-device switch. Sign-in and purchase never grant it. "Deletion requested" is not "Deleted".
- **DemoMark** marks mock behaviour in the references (any 6-digit code works, no real sync time, fake checkout). Never ship it; implement the real operation states instead.

## 7. Still open (don't invent these)
- Setup-step wording for Safari (iOS, macOS) and Firefox: the owner will confirm.
- Consent purpose text and provider names (bracketed placeholders).
- Support email address and setup-guide URL.
- Verified localized offer strings from each store ($9.99 is a labelled sample).
- The deep link from the Safari popup into the Still app's Still Pro section.
- Which deletion states the backend can report.
- The Firefox Android purchase channel and support. The Firefox Android store image is held.
