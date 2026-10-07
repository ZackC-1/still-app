# Still app UI kit (V3)

Screen recreations built only from the design-system components (`_ds_bundle.js`). Each page loads the bundle, then its own `.babel` screen script, so review screens never run inside the shared library.

| Page | Record | Status |
|---|---|---|
| `desktop-popup.html` | D01 Chrome/Firefox desktop popup | Approved 2026-10-02 (3.0.0) |
| `d02-mobile-popup.html` | D02 Safari iPhone/iPad and Firefox Android popup | Approved 2026-10-03 |
| `d03-settings.html` | D03 extension settings page | Approved 2026-10-03 |
| `d04-apple-settings.html` | D04 iPhone, iPad and Mac app settings | Approved 2026-10-03 (setup-step wording pending) |
| `d12-apple-onboarding.html` | D12 Apple onboarding (iPhone, iPad, Mac) | Approved 2026-10-03 |
| `d14-first-run.html` | D14 extension first-run page (Chrome, Firefox) | Approved 2026-10-03 |
| `d28-rating.html` | D28 rating prompt (browser invitation; Apple native) | Approved 2026-10-03 |
| `store-assets.html` | D41 Firefox Add-ons, D43 Chrome Web Store + App Store images, D45 icons | Approved 2026-10-03 (Firefox Android image held until support is proven) |
| `d18-purchase.html` | D18–D20, D24, D25 Still Pro view, purchase states, web return, success, Restore | Approved 2026-10-03 |
| `index.html` | Interim click-through (V3 components in the V2 layout) | Reference only |

What these pages are not:
- **Demonstration only:** sign-in accepts any 6 digits, sync shows no real timestamps, deletion and checkout are simulated. Each place is marked with a dashed "Demonstration only" pill (`DemoMark`).
- Prices are a labelled sample (US base price). Real offers come from verified localized store data.
- Native StoreKit and review sheets are never drawn; screens show the state before and after them.
- No in-page placeholders, hidden-content notices or default-on sharing. The only in-page screen is the TikTok blocked page (`TikTokBlocked`).
