# Public website

The HTML in `docs/` is the source. GitHub Pages serves the root of `gh-pages` independently.
`manifest.json` lists every public page, alias and asset. Builds do not crawl or copy the rest of
`docs/`. The generated directory is `.output/website/`.

```sh
pnpm build:website
pnpm test:website
python3 -m http.server 8766 --bind 127.0.0.1 --directory .output/website
```

The checks cover canonical/sitemap agreement, unique titles/descriptions, JSON-LD page identities,
HTML landmarks, image dimensions and alternatives, internal links/fragments, responsive-image and
CSS resources, alias parity, noindex return pages, crawl access and reachability from the homepage.
Tests inject failures into a temporary public tree. The normal CI check job runs both commands.

## Editing

Edit the HTML directly. Search engines receive content and metadata without running JavaScript.
Use the existing canonical URLs in links. Add a new page to the manifest, sitemap and relevant
visible guides. Update `lastmod` only after a meaningful page change; a build must never stamp
fresh dates on unchanged pages. Keep checkout returns out of the sitemap and preserve `noindex`
and `no-referrer`. Crawlers need access to observe `noindex`; robots.txt is not access control.

The homepage owns the shared `#website`, `#org` and `#app` entity IDs. Each public page identifies
its canonical URL, website and product. Breadcrumb markup matches the visible home/guides links
and page heading. Store URLs identify the actual Still listing. Do not add ratings, review counts,
corporate affiliations or unsupported-platform claims to improve schema validation scores.
SoftwareApplication remains semantic markup; without genuine review/rating data it does not meet
all of Google's software-app rich-result requirements. HowTo does not promise a Google rich result.

## Asset authoring

Normal build and checks use only Python's standard library. Optional asset authoring uses
FontTools 4.60.2 with Brotli and Pillow 11.3.0, installed in a separate virtual environment.
The original licensed Inter font and JPEGs remain the authoring sources. The build ships the
subset, its existing SIL license, responsive WebP variants and existing public asset URLs.

```sh
python3 -m venv /tmp/still-site-assets
/tmp/still-site-assets/bin/pip install 'fonttools[woff]==4.60.2' 'Pillow==11.3.0'
/tmp/still-site-assets/bin/pyftsubset docs/assets/InterVariable.woff2 \
  --output-file=docs/assets/StillLatinVariable.woff2 --flavor=woff2 \
  --unicodes='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-21FF,U+2713' \
  --layout-features='kern,liga,calt'
/tmp/still-site-assets/bin/python scripts/website/optimize-assets.py
```

The subset covers the current English pages. Before adding languages, extend the glyph coverage
or provide language-specific subsets. Keep the preload URL and both font-face declarations equal.
The screenshot `sizes` values follow the actual single/two-column CSS breakpoints.

## Publication

1. Reconcile the current live `gh-pages` tree and any active release holds against the source diff.
   Main is not a publication approval. In particular, do not publish pending V3 setup/support copy
   before its approved launch time.
2. Run the build and tests. Review the generated tree, domain file, public verification token,
   legacy image URL and the `/privacy/`, `/support/`, `/terms/`, `/setup/` aliases. The old full-font
   URL stays available for cached old stylesheets.
3. Propose the allowlisted artifact changes on a branch targeting `gh-pages`. Do not replace the
   branch with the entire repository or `docs/`, delete unrelated live files, or mix in held copy.
4. After approved publication, compare the live canonical/alias HTML and resource bytes with the
   approved artifact. Check normal TLS, HTTP and www redirects, robots.txt, sitemap and genuine 404s.
   GitHub Pages controls cache headers and redirects; `_headers` and `_redirects` files do not add
   those capabilities to this hosting setup.

Search Console URL Inspection and Rich Results Test are post-publication checks. Lab Lighthouse
is a useful regression check, not field CWV evidence. The audit and measurement plan are in
[`docs/research/2026-10-22-website-seo-audit.md`](../../docs/research/2026-10-22-website-seo-audit.md).
