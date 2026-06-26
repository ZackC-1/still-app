# Track 3 — Firefox Add-ons (addons.mozilla.org / AMO)

The Firefox build was **added in this PR** (a second target of the existing WXT project). Like Chrome,
this is a **free-tier launch** today (the in-extension Pro CTA is U8/U10 follow-on).

**Build artifact:** `packages/ext-chromium/dist/firefox-mv3` (MV3; **no** declarativeNetRequest —
Firefox doesn't reliably support DNR regexSubstitution redirects, so Shorts redirect uses the
browser-agnostic content-script path, same as Safari).

```bash
pnpm --filter @still/ext-chromium build:firefox   # → packages/ext-chromium/dist/firefox-mv3
pnpm --filter @still/ext-chromium zip:firefox      # → an extension .zip AND a -sources.zip (WXT makes both)
```

> WXT's `zip -b firefox` knows about AMO's source-code rule and emits **two** archives: the extension
> zip to upload, and a sources zip. **But** see §3 — for this **monorepo** the default sources zip is
> not enough on its own.

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
3. [ ] **Source code submission (required — this is the #1 rejection cause).** WXT/Vite output is
       minified, so AMO requires the source plus build instructions. A reviewer **rebuilds from your
       sources and diffs the result against your upload — it must match with zero differences** (their
       env: Ubuntu 24.04, Node 24, npm 11).

       ⚠️ **Monorepo gotcha:** Still's extension depends on the `@still/core` / `@still/shared-types`
       **workspace** packages, which live *outside* `packages/ext-chromium`. WXT's default sources zip
       only captures the extension folder, so a reviewer running `pnpm install` there cannot resolve the
       workspace deps and the rebuild fails. **Submit the whole repo as the sources archive** (it is
       already public — [github.com/ZackC-1/still-app](https://github.com/ZackC-1/still-app)) including
       the root `pnpm-workspace.yaml` and `pnpm-lock.yaml`. Provide these reviewer instructions:
       ```
       Source: full monorepo (public: github.com/ZackC-1/still-app).
       Build (Node 20+, pnpm):
         pnpm install
         pnpm --filter @still/ext-chromium build:firefox
       Output: packages/ext-chromium/dist/firefox-mv3  (matches the uploaded zip)
       Bundler: WXT 0.20 + Vite — minification only, NO obfuscation.
       ```
       Before submitting, **test the reproduction**: extract your sources zip to a clean dir and run the
       two commands — the output must equal your uploaded zip. Include the **lockfile**; **strip any
       `.env`** first (it can change chunk hashes and fail the diff).
       [Source code submission policy](https://extensionworkshop.com/documentation/publish/source-code-submission/)
4. [ ] **Signing is automatic** for a listed add-on — AMO signs the reviewed build; you do not run
       `web-ext sign` (that's only for unlisted/self-distributed builds). You can also automate the whole
       upload with `wxt submit` using an [AMO API key](https://addons.mozilla.org/en-US/developers/addon/api/key/).

---

## 4. Listing details

- [ ] **Name:** Still. **Summary** (**≤250 chars** — hard limit), **description** (HTML allowed).
- [ ] **Listing icons:** 32×32 and 64×64 PNG (AMO's listing sizes; the build also ships 16/48/96/128).
- [ ] **Screenshots:** at least one at **1280×800**.
- [ ] **Categories:** up to 2, e.g. "Privacy & Security".
- [ ] **Privacy:** paste a short policy into the listing form (an external link alone is insufficient) —
      or, since Still transmits no data, state "No data collected" (matches the manifest
      `data_collection_permissions: none`). **Data-consent (new Nov 2025):** the `none` declaration
      covers Firefox 140+; on older Firefox the no-data exemption means no post-install consent screen is
      needed — note this in reviewer notes.
- [ ] **"This add-on requires payment"** checkbox — leave unchecked for the free launch; check it when
      the Pro CTA ships.
- [ ] **License** for the listing; optional **support email/website**.

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
