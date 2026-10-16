---
title: Hide the mobile Facebook Page Reels tab; capture the mobile Home feed Reels section first
status: completed
date: 2026-10-15
---

# Hide the mobile Facebook Page Reels tab (ISS-0035, iPhone Safari)

## Problem

On a physical iPhone in Safari, with the Facebook Blocker on, owner QA on 2.1.1.361 found two
Reels surfaces still showing on Facebook's mobile layout. Safari on the Mac passes both desktop
equivalents (MAC-18, MAC-20), so the gap is limited to the mobile markup.

1. **Page Reels tab (IOS-19).** A brand Page shows the tabs All / Photos / Reels / Mentions, and
   the Reels tab opens the Page's Reel grid.
2. **Home feed Reels section (IOS-17, IOS-33).** A "Reels" section (icon, "Reels", a "…" menu and
   a large Reel card with a play button) appears in the Home feed.

The menu Reels item hiding (IOS-17, first half) and the `/reels` and `/watch/reels` redirects
(IOS-18) already pass and must not change.

## Evidence (structural capture, 15 Oct)

Signed out, in Playwright WebKit with the iPhone 15 Pro device profile, `m.facebook.com/nike/`
and `www.facebook.com/nike/` both serve the same mobile Page layout the owner's screenshot shows.
The capture kept only tags, roles, aria-labels on interface controls, inline sizes and the names of
`data-*` attributes. No account was used and nothing was signed in to.

- The tab row is `div[role="tablist"] > div[role="tablist"]`. Each tab is an **outer**
  `div[role="tab"]` (the tap target, which carries `data-action-id` except on the selected tab) whose
  child `div` holds an **inner** `div[role="tab"]` with `aria-label="All"`, `"Photos"`, `"Reels"`
  or `"Mentions"`, and the label text in a `span`.
- The label is exactly `Reels`. The current mobile rule
  `[role="tab"][aria-label^="Reels," i] > *` was written for an older tab bar labelled
  `Reels, 4 of 6`, so it matches nothing here. **This is the root cause of IOS-19.**
- Tapping the Reels tab moves to `/<page>/reels/`, which draws the same row with Reels selected and
  the Reel grid below it.
- The layout is computed by the server: every tab has a fixed width and an absolute
  `margin-left`, and each tab after the first is pulled back up with `margin-top:-46px`.
  Hiding the outer Reels tab leaves the other three in place, with a blank 93 px slot between
  Photos and Mentions. CSS cannot close the gap because the offsets are inline styles. A live test
  (`display:none` on the outer tab on `/nike/`, `/nike/reels/` and `/natgeo/`) showed no attribute
  or child mutation in the row over 3 seconds and no change in the other tabs' positions. Only a tab
  after the first can go: every later tab is pulled up against the one before it, so hiding the first
  tab would slide the rest out of the clipped row. A row that starts with Reels is left alone.
- Hiding only the label (the old `> *` approach) would leave an invisible 93 px area that still
  opens the Reel grid when tapped. The outer tab has to go.

### Not captured: the Home feed Reels section

The mobile Home feed needs a signed-in account; signed out, `m.facebook.com/` is the login page.
The signed-out Watch page has a Reels shelf (an `h2` "Reels" header and a horizontal scroller of
tiles labelled `View reel video …`), but that is not the Home feed card in the owner's screenshot
and must not be used as a stand-in. The mobile feed is a flat list of rows inside
`div[data-type="vscroller"]`: a single post is several sibling rows (header, text, media,
reactions, actions) with no wrapper around them, and the Watch shelf header is plain text with no
label. Until a capture shows what marks the Home section, a selector would be a guess. Per the
14 Oct decision, none ships.

## Approach

1. Add the captured tab row as a fixture (`tests/fixtures/facebook-mobile-page.html`), using
   placeholder Page content and neutral `data-*` values.
2. Tests first (they must fail on `main`):
   - core (`facebook-format2.test.ts`): the outer Reels tab hides; All, Photos and Mentions and
     their inner tabs stay visible, keep their HTML and keep their inline geometry; a tab whose
     label only contains "Reels" stays; Off restores the tab;
   - Chromium extension (`fixtures-format2.spec.ts`): the outer Reels tab is hidden on the Page
     and on its `/reels/` address, the other tabs do not move, an ordinary video post stays, and live
     Off/On restores and then re-hides it;
   - the mobile Home feed Reels cases are recorded as `todo` until the capture arrives.
3. Fix: one format-2 selector,
   `[role="tablist"] > [role="tab"] ~ [role="tab"]:has(> * > [role="tab"][aria-label="Reels"])`. It is bounded by
   the site's own tab structure, fails open if the nesting changes, and leaves the older mobile
   rule in place. Regenerate `format2.json` (rule set 3.0.13).
4. Keep the desktop rules unchanged: MAC-18..21, CH-18..21 and FX-18..21 must keep passing.

## Owner step needed for the Home feed (IOS-17 feed half, IOS-33)

On the Mac, with the iPhone connected and Safari Web Inspector enabled (iPhone Settings > Apps >
Safari > Advanced > Web Inspector; Mac Safari > Develop > [iPhone] > facebook.com): open the
facebook.com Home feed, scroll until the "Reels" section is on screen, then paste the snippet below
into the Console and send back the printed text. It prints only tag names, roles, interface labels
reduced to a word template, `data-*` attribute names and sizes. Facebook addresses keep only
their route words (such as `reel`, `groups`, `posts`), with every other part printed as `w` or `N`;
other sites print as `external`. It prints no names, post text, images or addresses.

```js
(() => {
  const keep = /^(reel|reels|views?|plays?|video|videos|view|by|watch|play|live|post|public|see|all|more|options|for|of|and|the|a|sponsored|stories|story|hide|menu)$/i;
  const tmpl = (s) => s.split(/(\s+|,|\.|·)/).map((w) => (/^\s*$|^[,.·]$/.test(w) ? w : keep.test(w) ? w : /^\d[\d.,KM]*$/.test(w) ? "N" : "w")).join("");
  const desc = (el) => {
    const a = [];
    for (const at of el.attributes) {
      if (at.name === "class" || at.name === "id") continue;
      if (at.name === "style") { const m = at.value.match(/(width|height):[^;]+/g); if (m) a.push(`style~${m.join(";")}`); continue; }
      if (at.name.startsWith("data-")) a.push(["data-mcomponent", "data-type", "data-is-reels"].includes(at.name) ? `${at.name}="${at.value}"` : at.name);
      else if (["role", "aria-hidden", "tabindex"].includes(at.name)) a.push(`${at.name}="${at.value}"`);
      else if (at.name === "aria-label") a.push(`aria-label="${tmpl(at.value)}"`);
      else if (at.name === "href") {
        let u;
        try { u = new URL(at.value, location.href); } catch { a.push('href="?"'); continue; }
        if (!/(^|\.)facebook\.com$/.test(u.hostname)) { a.push('href="external"'); continue; }
        const route = /^(reel|reels|reels_tab|watch|groups|posts|videos|photos|stories|hashtag|story\.php|profile\.php|permalink\.php|l\.php)$/;
        const segs = u.pathname.split("/").filter(Boolean).map((p) => (route.test(p) ? p : /^\d+$/.test(p) ? "N" : "w"));
        a.push(`href="/${segs.join("/")}${u.pathname.endsWith("/") && segs.length ? "/" : ""}"`);
      }
      else a.push(at.name);
    }
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
    return `<${el.tagName.toLowerCase()} ${a.join(" ")}>${own ? (keep.test(own) ? ` «${own}»` : " «text»") : ""}`;
  };
  const scroller = document.querySelector('[data-type="vscroller"]');
  if (!scroller) return "no vscroller";
  const rows = [...scroller.children];
  const hasReels = (r) => [...r.querySelectorAll("*")].some((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === "Reels"));
  const hits = rows.map((r, i) => (hasReels(r) ? i : -1)).filter((i) => i >= 0).slice(0, 4);
  if (!hits.length) return "no Reels section in view; scroll until it is on screen and run again";
  const out = [`rows=${rows.length} hits=${hits.join(",")}`];
  const walk = (el, d) => { if (d > 16) return; out.push("  ".repeat(d) + desc(el)); for (const c of el.children) walk(c, d + 1); };
  for (const at of hits) for (let i = Math.max(0, at - 1); i <= Math.min(rows.length - 1, at + 3); i++) { out.push(`=== row ${i} (hit ${at})`); walk(rows[i], 0); }
  return out.join("\n");
})();
```

With that output the Home feed fixture (initial load and a section appended after scrolling) and
its tests can be written from real structure, then the selector.

## Home feed capture and fix (16 Oct)

The owner ran the snippet on the signed-in Home feed in iPhone Safari with the Facebook Blocker
off. It showed:

- Each feed unit is **one** direct child row of `div[data-type="vscroller"]`, with a 1 px divider
  row between units. (Page timelines split a post into several rows; the Home feed does not.)
- The Reels section is one 488 px row: a header container three wrappers down holding an icon, an
  `h2` "Reels" and a `role="button"` "See more …", above a carousel of reel cards, each a
  `role="button"` whose label starts `View reel video …`.
- The next row, an ordinary video post, holds its header, text, an `MVideo` with
  `data-is-reels="false"`, reactions and actions in that single row.

Signed out, WebKit with the iPhone 15 Pro profile, the vscroller rows on `m.facebook.com/watch/`,
`/nike/` and `/natgeo/` compute to `position: static` or `relative` and stack with `margin-top`,
so hiding a row closes up. The new selector matched nothing on those three pages (their `h2`
sections hold no reel cards, and the Watch Reels shelf's `h2` sits at a different depth).

Fix: `[data-type="vscroller"] > :has(> * > * > * > h2):has([role="button"][aria-label^="View reel"])`,
rule set 3.0.15. It needs both the section header at the captured depth and a reel card, so a
single shared reel (no header), a headed section without reel cards and the same markup nested
inside a post all stay. New fixture `tests/fixtures/facebook-mobile-home.html`; the core tests
replaced the two `todo` cases and failed before the rule (4 of 4); the Chromium extension test
checks the row hides, the post below moves up to sit under the dividers, and live Off/On.

## Retest

IOS-19 (Page Reels tab absent with Facebook Blocker On; All, Photos and Mentions work; live Off/On
restores it), IOS-17 and IOS-33 (the Home feed Reels section is gone, the feed has no blank gap,
ordinary video posts and Stories stay, live Off/On restores it), and the desktop
regression set CH-18..21, MAC-18..20, FX-18..20.

## Risks

- The label is matched in English, as the desktop label fallbacks are. Other languages fail open.
- A blank slot is left where the Reels tab was, because Facebook positions the mobile tabs with
  fixed inline offsets. Showing a gap is preferred over leaving an invisible tap target.
- A Page's `/reels/` address stays reachable by typing it, as on desktop; the free core keeps a
  Page's own Reels tab routes usable (`engine.ts`).
- The legacy seed lane (devices whose saved settings are still schema 1) is unchanged.
- Rule set version: a parallel Instagram change may also bump `format2.json`; whichever merges
  second regenerates it with the next version.
- The Home feed rule depends on the header's depth and the English `View reel` label. If Facebook
  changes either, the section shows again (fails open) rather than hiding anything else.
- Facebook loads more feed when a row becomes visible; a hidden row never does, which costs nothing
  but means the section's own impression is not reported.
