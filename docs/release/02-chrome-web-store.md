# Track 2 — Chrome Web Store (Chromium extension)

Fast and cheap ($5 one-time, no hardware). Ships the **free** Shorts remover today. The in-extension
"Unlock Pro" CTA (Supabase sign-in + RevenueCat Web Billing) is deferred work (U8/U10) — the server
side is ready, but the extension UI doesn't expose a buy button yet, so this is a **free-tier launch**.

**Build artifact:** `packages/ext-chromium/dist/chrome-mv3` (MV3, DNR Shorts-redirect, host permissions
limited to the 4 service domains).

```bash
pnpm --filter @still/ext-chromium build   # → packages/ext-chromium/dist/chrome-mv3
pnpm --filter @still/ext-chromium zip      # → a store-ready .zip
```

---

## 1. Register the developer account

1. [ ] Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. [ ] Pay the **one-time $5** registration fee.
3. [ ] Complete **identity / contact verification** (Google now requires a verified email + may require
       more for new accounts; new developers can face a brief account-age gate before publishing).
4. [ ] **EU note (DSA Trader status):** if you target EU users, the dashboard requires you to declare
       **Trader** status (you're selling, even if the listed item is free + external Pro). Fill the
       Trader contact details. [Trader verification FAQ](https://developer.chrome.com/docs/webstore/program-policies/trader-verification-faq)

Docs: [Register as a developer](https://developer.chrome.com/docs/webstore/register)

---

## 2. Listing assets

- [ ] **Icon:** 128×128 PNG (already in the build).
- [ ] **Screenshots:** at least one, **1280×800** (or 640×400).
- [ ] **Small promo tile:** 440×280. **Marquee** (optional): 1400×560.
- [ ] **Description**, **category** (Productivity), **language**.
- [ ] **Privacy policy URL** (HTTP 200) — required because the extension requests host permissions.

Docs: [Prepare your store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)

---

## 3. Privacy practices tab (this is where content blockers get rejected)

1. [ ] **Single purpose** statement: "Still removes short-form video (YouTube Shorts) from supported
       sites." Keep it to the one purpose.
2. [ ] **Permission justifications** — justify each:
       - `declarativeNetRequestWithHostAccess` → "Redirect YouTube Shorts URLs to the standard watch
         page at the network layer (no page flash)."
       - `storage` → "Persist the user's on/off and per-site settings locally."
       - `activeTab` → "Let the toolbar popup pause Still on the current site without broad access."
       - host permissions (`youtube/instagram/facebook/tiktok`) → "Apply the content rules only on the
         sites Still supports." (Never `<all_urls>`.)
3. [ ] **Data usage** disclosures + the certification checkboxes: Still collects/transmits **no** user
       data from the extension today → declare none. **No remote code** (MV3; all code is in the package).

Docs: [User data privacy policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) ·
[Program policies](https://developer.chrome.com/docs/webstore/program-policies/policies)

---

## 4. External payments policy (for when the Pro CTA lands)

Chrome Web Store's own payments are **deprecated**. Still's Pro is an **external** RevenueCat Web
Billing checkout. Per the current [program policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
(updated 2025-05), linking out to your own checkout for digital goods is allowed — you just must not
be deceptive about it. When the Pro CTA ships:
- [ ] Disclose in the listing that Pro is a paid upgrade purchased on the web.
- [ ] The CTA opens the RevenueCat Web Purchase Link in a new tab; no payment happens inside the
      extension surface.

(Nothing to do for the free-tier launch.)

---

## 5. Upload + submit

1. [ ] Dashboard → **Add new item** → upload the **`.zip`** from `pnpm --filter @still/ext-chromium zip`.
2. [ ] Fill the listing + privacy tabs (above) → **Submit for review**.
3. [ ] Review is typically hours-to-days; extensions with host permissions can take longer.
4. [ ] Use **staged rollout** for the first version if you want a gradual release.

---

## Pre-empt the common rejections

- [ ] **Single purpose** clearly stated and narrow.
- [ ] **Every permission justified**; host permissions scoped to the 4 domains, never `<all_urls>`. ✅
- [ ] **No remote code** (MV3, all bundled). ✅
- [ ] **Privacy policy URL live** and data-use disclosures match reality (no data collected).
- [ ] Honest install flow — no misleading screenshots or "you must install X" dark patterns.

## Done when

- [ ] Extension **Published** and installable from its store URL.
- [ ] Free YouTube Shorts removal verified on a clean Chrome profile.
