# Website technical SEO

Status: implementation and local verification complete; publication remains separate
Branch: `seo/site-wide-20261022`

Owner direction, October 22: prepare a GitHub PR targeting `main`; publish the website with the V3
release. Do not merge or publish as part of branch preparation. Reconcile PR #484 setup instructions
with this branch's setup-page navigation, metadata and canonical links before website publication.

## Scope

Audit all public HTML, assets, URLs, links and publication architecture for stillapp.fit. Improve
search intent, supported-surface clarity, related guides, brand/entity metadata, crawlability and
font delivery while keeping the current visual system and free product behavior. Leaked names
(titlematchScore, site2vecEmbedding, siteLinkIn/siteLinkOut, pnav/pnavClicks, impressions,
chromeInTotal, directFrac) are question prompts only. Their presence does not establish ranking
use, weighting or a measurable optimization target. No traffic generation or added tracking.

## Implementation

1. Record public URL, link and performance baselines and consult Google Search Central guidance.
2. Align static metadata, canonical internal URLs and visible navigation; connect supported-service
   guides and add distinct Facebook Reels and TikTok help using documented current behavior.
3. Connect WebSite, Organization, SoftwareApplication, WebPage and breadcrumb entities without
   invented reviews, affiliations, dates or rich-result promises. Keep existing truthful HowTo.
4. Subset the licensed font, prioritize its discovery, preserve image sizing and motion controls.
5. Add an allowlisted static publication build and checks for aliases, links, schema and indexability.

## Verification

- Build the public tree only; verify every internal link, asset, fragment, canonical and sitemap URL.
- Keep checkout return pages noindex and crawlable; verify genuine 404 behavior.
- Exercise mobile/desktop rendering, downloads, guide navigation and animation preferences.
- Compare identical local lab profiles before/after; report bytes and timings, never field CWV claims.
- Record outbound status, redirect and bot-block limitations separately from broken links.

## Publication and measurement

Main's `docs/` is source; gh-pages root is the publication. Prepare and validate the source change
without publishing V3 setup/support material held for launch. Keep the existing custom domain,
verification token and legacy aliases. No DNS, store, payment or analytics configuration changes.
After approved publication, verify HTTP redirects, aliases, headers and sitemap with normal TLS.
Use Search Console's previous 28 complete days versus the next 28 complete days, segmented by
page, query and device: impressions, clicks, CTR, branded/nonbranded queries and indexed canonical
coverage. Record installs using existing store campaign links. Check CrUX/Search Console p75 LCP,
INP and CLS when enough field data exists. No ranking or growth outcome is claimed by this change.


## Verification receipt

- `pnpm build:website`: passes; 12 canonical pages and 21 HTML routes, no orphan pages or broken links.
- `pnpm test:website`: 10 passing failure-injection checks.
- `pnpm lint`, `pnpm typecheck`, `git diff --check`: pass.
- Chromium/WebKit: 48 page/viewport checks plus five device/store/motion checks; JavaScript-disabled
  rendering and Android scope checks also pass. No overflow or broken resources.
- Three clean Lighthouse mobile runs before and after: median performance 81 to 98, LCP 4.36 to
  2.40 seconds, loaded bytes 789,898 to 323,171; TBT stays 0. Field CWV/INP remain unverified.
- Live canonical/alias and 24 unique outbound destinations: HTTP 200; normal TLS, HTTP/www
  redirects and unknown-path 404 verified. No external state was changed.
- Mem0 retrieval returned its monthly quota error; repository findings provide durable context.

Full findings, limitations, public guidance and off-site actions:
[technical SEO audit](../research/2026-10-22-website-seo-audit.md).
