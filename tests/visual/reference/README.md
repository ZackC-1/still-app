# Capture the supplied references

Use the latest owner design package (internal version `3.0.1`) and a prepared cache. The cache
contains `0.js`, `1.js`, and `2.js`: React 18.3.1, ReactDOM 18.3.1, and Babel standalone 7.29.0,
in the order of `PINNED_INPUTS` in `capture.mjs`. Each file must match its fixed URL's SHA384.
This command does not download dependencies. It uses the repository's Playwright installation
and the supplied handoff's existing `pngjs` dependency.

```sh
node tests/visual/reference/capture.mjs \
  --package /absolute/path/to/latest-design-package \
  --cache /absolute/path/to/prepared-cdn-cache \
  --output /absolute/path/to/new-capture-directory \
  --icons
```

The output directory must be new, its parent must exist, and it must be outside the package and
cache. Existing outputs and accepted references are never reused. `--icons` adds one separately
labeled D45 icon-page supplement; the primary inventory remains 144 DOM frames. The supplied
114 template declarations expand into those 144 frames through live component loops.

Capture serves unchanged snapshotted package files on localhost, fulfills only the three exact
cached external URLs, and blocks other outbound requests, service workers and WebSockets.
It validates source version declarations before launching, requires loaded InterVariable faces
and actual custom Inter glyph use, and decodes every PNG to verify its dimensions at scale 2,
including fractional bounds. Only the exact known corrupted wordmark image URL is replaced
in the rendered DOM with the verified existing shared Still asset; neither supplied source nor
accepted pixels are edited. The receipt records both hashes and substitution counts.

`capture-receipt.json` records browser, font, input, frame and before/after source evidence.
`references/render-inventory.json` and `frame-context-inventory.json` support the existing visual
comparison tools. Compare a fresh capture with accepted references separately; capture success
is not pixel parity, installed-app evidence, Safari engine evidence or approval to replace references.
Failed runs leave an explicitly failed receipt in their newly reserved output.

Run the preflight and confinement controls without launching a browser:

```sh
node --test tests/visual/reference/capture.test.mjs
```
