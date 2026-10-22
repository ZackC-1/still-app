# stillapp.fit technical SEO audit

Date: October 22, 2026. Scope: the entire public GitHub Pages site, including 10 existing canonical
HTML pages, four checkout return pages, duplicate aliases, linked assets, outbound destinations,
robots.txt, sitemap, hosting and the matching `docs/` sources. Internal product/design documents
and the extension/app UI are not public website pages. Implementation branch: `seo/site-wide-20261022`.

Status: implemented and locally verified; not published. Main source and gh-pages are separate.
The owner scheduled publication with the V3 release on October 22, 2026. Reconcile the separate
setup/support work, including PR #484, before that publication. No store, DNS, payment or analytics
configuration changed. Live observations below describe the site before this branch is published.

## Findings and changes

| Area | Observed baseline | Implemented behavior |
| --- | --- | --- |
| Intent and scope | Homepage H1 implied mobile Chrome/Firefox support; Facebook/TikTok absent from H1. Some titles overlong or generic. | Explicit four-service H1, mobile Safari boundary in the adjacent description, distinct page titles/descriptions and aligned social metadata. Existing owner-approved headline and visual system preserved. |
| Internal links | Sitemap/canonicals used `/setup/`, `/support/`, `/privacy/`, `/terms/`, while links often used `.html`. Each YouTube/Instagram guide had one distinct referring page. | Canonical root-relative links, shared inner-page navigation, homepage service links, contextual related guides and setup links. YouTube now has five distinct referring pages; Instagram six. All 12 canonical pages are reachable from home. |
| Content | Useful guides covered YouTube and Instagram, with no dedicated Facebook/TikTok help. | Two distinct guides cover setup, permission checks, troubleshooting and product boundaries. Facebook preserves ordinary posts/messages; TikTok blocks the whole website. Mobile Safari and native-app limits remain explicit. |
| Entities and brand | Organization and SoftwareApplication existed only on home; no WebSite identity or breadcrumb relationships. | Stable linked `#org`, `#app`, `#website` identities, one canonical page entity per page, visible breadcrumb context and BreadcrumbList; guide index lists the actual guides. Official store URLs tie the app identity together. |
| Crawl/index rules | QA return pages were both robots-disallowed and HTML noindex. Canonical duplicates existed deliberately. | Crawlers can read return-page noindex. Returns stay out of the sitemap. Legacy aliases remain byte-identical and canonicalize to existing preferred URLs. The sitemap contains exactly 12 canonical pages with dates of actual edits. |
| Outbound links | All 24 unique destinations returned 200. Chrome's old listing slug resolved to a renamed slug. | Chrome listing links use the observed current slug and same immutable app ID. Store campaign parameters and Apple's attribution URLs preserved. No blanket nofollow on useful editorial or store links. |
| Delivery | Inter font was 352,240 bytes; screenshots loaded full-size JPEGs even on small screens. | 65,700-byte English font subset, early font discovery and 480/800/1280 WebP screenshot variants. Original source assets and legacy public URLs retained. No added runtime framework or tracking. |
| Accessibility/navigation | Lighthouse flagged a 4.44:1 small-text contrast ratio and brand label mismatch. Most guide pages lacked a main landmark. | Small contrast correction, matching brand accessible label, skip links, main landmarks and persistent inner-page navigation. Existing animation pause, offscreen suspension and reduced-motion behavior preserved. |
| Publication | Source merges alone do not publish; aliases and live-only domain/verification files required manual care. | Manifest-driven public build, exact alias copies, public domain/verification files, link/schema/indexability checks and a CI gate. Repository plans, memories and private evidence are excluded. |

## Leak names and evidence boundary

`titlematchScore` prompted intent-aligned titles; `site2vecEmbedding` prompted accurate, connected
subject coverage. `siteLinkIn`/`siteLinkOut` prompted the link graph and destination audit.
`pnav`/`pnavClicks` prompted consistent brand identification and navigation. `impressions`,
`chromeInTotal` and `directFrac` prompted an experience and measurement review. These names do not
establish active ranking factors, weights or targets. No click simulation, artificial visits,
engagement loops, keyword stuffing, fabricated reviews or paid-link schemes were added.

Google's published guidance supports [descriptive titles](https://developers.google.com/search/docs/appearance/title-link),
[crawlable, descriptive links](https://developers.google.com/search/docs/crawling-indexing/links-crawlable),
[consistent canonical signals](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls),
and [WebSite identity](https://developers.google.com/search/docs/appearance/site-names).
Crawlers must be allowed to see [noindex](https://developers.google.com/search/docs/crawling-indexing/block-indexing).
Structured data describes visible content; the existing application has no invented review/rating
and does not meet every [software-app rich-result requirement](https://developers.google.com/search/docs/appearance/structured-data/software-app).
Keeping truthful HowTo markup does not imply eligibility for a Google HowTo rich result.

## Verification

`pnpm build:website` validates 12 canonical pages and 21 HTML routes. `pnpm test:website` passes
10 failure-injection checks, including broken assets/fragments, noncanonical links, alias drift,
blocked noindex discovery, incorrect sitemap inclusion, invalid JSON-LD and accidental extra HTML.
Repository lint and typecheck pass. The app build, extension fixture suite and Apple device suite
were not run because this branch changes the public website and its tooling, not app behavior.

Chromium and WebKit each loaded all 12 pages at 390 and 1440 pixels with no horizontal overflow,
broken resources or script exceptions. Both rendered working downloads and guides without JS.
Five device/user-agent checks preserved iPhone, iPad, Mac Safari, desktop Chrome and desktop Firefox
store selection and motion controls. Android kept its unsupported notice. These are local browser
checks, not physical-device certification. Screenshots of home, setup and the new guide were reviewed.

Live TLS and all canonical/alias requests succeeded. HTTP and www requests resolved to the HTTPS
apex. An unknown URL returned 404. All 24 outbound destinations returned 200, including Apple's
refund URL leading to its sign-in service. The hosting cache policy is controlled by GitHub Pages;
no unsupported `_headers` or `_redirects` workaround was added.

Mobile Lighthouse 13.5.0 used the same default simulated mobile profile against two local Python
static servers: the pre-change source tree and the final public artifact. Three runs per version
were used; the table reports medians. Local hosting isolates the resource changes but does not
reproduce GitHub Pages compression, CDN timing, cache headers or real visitor conditions.

| Metric | Before | After |
| --- | ---: | ---: |
| Performance score | 81 | 98 |
| Largest contentful paint | 4.36 s | 2.40 s |
| Total loaded bytes | 789,898 | 323,171 |
| Total blocking time | 0 ms | 0 ms |
| Cumulative layout shift | 0.0004 | 0 |
| Accessibility score | 96 | 100 |
| Best practices score | 96 | 100 |
| SEO audit score | 100 | 100 |

Loaded bytes fell 59%; the font alone fell 81%. The baseline's missing favicon and accessibility
findings were resolved. A preliminary after-run hit a local socket error and was excluded;
three subsequent clean runs had no console/network failures. The original SEO score was already
100, illustrating that Lighthouse's checklist does not measure topical quality or rankings.
The subset contains every visible glyph on the current public English pages. Source JPEGs remain
available, and current screenshots use responsive WebP. No animation rendering code changed.

Local raw reports, screenshots and browser evidence are in `/tmp/still-seo-evidence-20261022/`.
The browser check script is `.output/website-browser-check.mjs` in the task worktree. These are
local evidence, not public-site files. The durable summary is this document.

## Publication and off-site actions

Use [the publication checklist](../../scripts/website/README.md). Reconcile the live branch before
publishing; preserve current policy bytes, aliases, verification token, store attribution and held
release content. After publication, inspect canonical URLs in Search Console, submit the updated
sitemap and run Google's Rich Results Test. Canonicals are hints, so inspect Google's selected
canonical rather than assuming the tag determines it.

Record the 28 complete days before publication and compare the next 28 complete days, segmented by
page and device. Track impressions, clicks, CTR, query position (as context), branded queries such
as “Still blocker,” nonbranded service queries, indexed canonical coverage, and existing store
campaign installs. New pages have no historical baseline; evaluate them separately. Account for
release timing and seasonality. No Search Console connector was available, and the public
PageSpeed API returned a quota error, so no private search metrics or CrUX result is claimed.

For field experience, use [p75 LCP, INP and CLS](https://web.dev/articles/vitals): good targets are
LCP at most 2.5 seconds, INP at most 200 ms and CLS at most 0.1, evaluated separately for mobile and
desktop when enough field data exists. Lab TBT is not INP, and one lab score does not establish a
field Core Web Vitals pass.

Off-site priorities: keep the product name, website link and mobile boundary consistent across
store listings and owned profiles; seek relevant editorial reviews and useful mentions through
ordinary outreach; respond to real support/review feedback and turn recurring verified questions
into guide updates. Search Console query data should decide the next content expansion. No new
tracking, outreach messages, listing edits or public posts were sent by this task.
