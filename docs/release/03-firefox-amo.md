# Track 3 — Firefox Add-ons (addons.mozilla.org / AMO)

The Firefox build was **added in this PR** (a second target of the existing WXT project). Like Chrome,
this is a **free-tier launch** today (the in-extension Pro CTA is U8/U10 follow-on).

**Build artifact:** `packages/ext-chromium/dist/firefox-mv3` (MV3; **no** declarativeNetRequest —
Firefox doesn't reliably support DNR regexSubstitution redirects, so Shorts redirect uses the
browser-agnostic content-script path, same as Safari).

```bash
pnpm --filter @still/ext-chromium build:firefox   # → packages/ext-chromium/dist/firefox-mv3
pnpm --filter @still/ext-chromium zip:firefox      # → a store-ready .zip + a sources .zip
```

> **Verified already:** `web-ext lint` on the build reports **0 errors** (the lone warning is Svelte 5's
> internal `innerHTML` template runtime — benign, present in every Svelte extension). The manifest has
> the required `browser_specific_settings.gecko.id` and `data_collection_permissions: {required:["none"]}`.

---

## 1. Key Firefox manifest facts (already set in `wxt.config.ts`)

| Field | Value | Why |
|-------|-------|-----|
| `manifest_version` | 3 | matches Chrome/Safari builds |
| `browser_specific_settings.gecko.id` | `still@chartash.com` | **PERMANENT** add-on id once published — change it *before* first submit if you want a different one |
| `gecko.data_collection_permissions` | `{ required: ["none"] }` | Firefox data-consent; Still collects no data. Becoming mandatory for new AMO submissions |
| background | event page (`scripts`) | WXT emits the Firefox-correct shape; the DNR-gating wiring no-ops on Firefox |
| host permissions | the 4 service domains | never `<all_urls>` |

> If you want to also reach **Firefox for Android**, this same listing can be made Android-compatible —
> see [`05-future-google-play.md`](05-future-google-play.md).

---

## 2. Create an AMO developer account

1. [ ] Sign in / create a Firefox account, then go to the
       [AMO Developer Hub](https://addons.mozilla.org/developers/).
2. [ ] No fee. Read the [Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
       and [Firefox Add-on Distribution Agreement](https://extensionworkshop.com/documentation/publish/firefox-add-on-distribution-agreement/).

---

## 3. Submit the extension (listed) + the required source

1. [ ] Dev Hub → **Submit a New Add-on** → choose **On this site** (listed on AMO).
2. [ ] Upload the **`.zip`** from `zip:firefox`. Automated validation runs (it's the same engine as
       `web-ext lint` — you've already passed it).
3. [ ] **Source code submission (required for this build).** WXT/Vite output is **minified/bundled**, so
       AMO's policy requires you to also upload the **source** plus build instructions so a reviewer can
       reproduce the artifact. Upload a source archive and provide:
       ```
       Build: Node 20+, pnpm. From repo root:
         pnpm install
         pnpm --filter @still/ext-chromium build:firefox
       Output: packages/ext-chromium/dist/firefox-mv3 (matches the uploaded zip).
       Bundler: WXT 0.20 + Vite. No obfuscation; minification only.
       ```
       [Source code submission policy](https://extensionworkshop.com/documentation/publish/source-code-submission/)
4. [ ] **Signing happens automatically** when you submit a listed add-on — AMO signs the reviewed build;
       you don't run `web-ext sign` yourself for listed distribution.

---

## 4. Listing details

- [ ] **Name:** Still. **Summary** (≤250 chars), **description**.
- [ ] **Icon** (128×128, in the build), **screenshots**.
- [ ] **Categories:** e.g. "Privacy & Security" / "Photos, Music & Videos".
- [ ] **Privacy policy URL** (HTTP 200) + the **data collection** disclosure → "No data collected"
      (matches the manifest `data_collection_permissions: none`).
- [ ] **License** for the listing.

---

## 5. External payments (for when the Pro CTA lands)

Mozilla allows add-ons to link out to an external paid upgrade. When the Pro CTA ships, it opens the
RevenueCat Web Purchase Link in a new tab (no payment inside the add-on). Disclose the paid upgrade in
the listing. (Nothing to do for the free-tier launch.)

---

## 6. Review + publish

- [ ] Submit → **human review** follows automated validation. Listed add-ons that request host
      permissions and submit source are reviewed manually; budget a few days.
- [ ] After approval the add-on is live at its `addons.mozilla.org` URL and auto-updates from AMO.

Docs: [Submitting an add-on](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/) ·
[web-ext reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)

---

## Pre-empt the common rejections

- [ ] **Source not provided / not reproducible** — the #1 reason bundled extensions get held. Include the
      build instructions above. ✅ (steps provided)
- [ ] **Permissions too broad** — scoped to the 4 domains, not `<all_urls>`. ✅
- [ ] **Missing `gecko.id`** — set. ✅
- [ ] **Missing data-collection consent** — declared `none`. ✅
- [ ] **Minified with no source** — covered by the source upload. ✅

## Done when

- [ ] Add-on **Approved** and live on AMO.
- [ ] Free YouTube Shorts removal verified on a clean Firefox profile (load `dist/firefox-mv3` via
      `about:debugging` → "This Firefox" → "Load Temporary Add-on" for a pre-submit smoke test).
