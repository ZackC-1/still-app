# Chrome QA lane (L1q)

Journeys on the real built Chrome extension, plus a visual runner that compares real extension pages
with the design package. Opt-in: the `qa` Playwright project is not part of the CI fixtures run.

```bash
pnpm --filter @still/ext-chromium build          # the V3 (unconfigured) build
pnpm exec playwright test --project=qa --workers=2
pnpm visual:real                                 # T1 real-extension frames vs the design package
pnpm visual:real -- --self-test                  # proves the gate fails a 2px shift
```

- `chromium/` holds the journey specs. Cell ids in test names (`J1.CH`, `J4.CH`, ...) follow the QA plan.
- `shared/` holds the helpers: `launch.mjs` (load the build, read and write real storage through the
  extension's own context), `fixtures.ts` (the `qa` test object at 2x), `evidence.ts` (screenshots, a
  redacted storage dump, a network log with no query strings or headers), `serve.ts` (recorded pages
  only, never a real site) and `loader.ts` (Chrome's own loader, for a real install, update or removal).
- Evidence goes to `tests/qa/.output/evidence/<cell>/` (gitignored). Set `STILL_QA_EVIDENCE` to move it.
- Lanes: specs run on the unconfigured V3 build. With `STILL_TEST_SYNC_CONFIGURED=true` (a configured
  2.x build, pointed at with `STILL_CHROMIUM_EXTENSION`) V3-only specs skip. The permission and
  paid-dormant checks hold on both.
- Sign-in and sync journeys are `test.fixme` until the local backend recipe (QA-P7) exists.

## Visual runner

`tests/visual/real/run.mjs` captures the popup (opened as a page at the popup size), options,
first-run and TikTok blocked pages at deviceScaleFactor 2 and compares each with the package's 2x
reference using the package's own `compare.script`: pass only when differing pixels x 200 <= total
pixels. No masks, no reference edits. It exits 1 before browser launch when the comparator, references, or latest `3.0.1` inventory
are missing or invalid. The default source is `docs/design/Still v3.1 redesign/source`; set
`STILL_VISUAL_REFERENCE_DIR` to the generated reference directory. Comparator dependencies
resolve from `source/handoff/package.json` (including dependencies installed in its parent). Frames whose state cannot be reached yet are reported `BLOCKED`
with the reason and a non-passing aggregate, never as passes. Reports include selected
source/reference paths, comparator and inventory hashes, the built artifact digest, and a
coverage ledger for all 144 DOM frames. Preflight decodes every PNG and checks the renderer’s
outward-rounded CSS bounds at 2x. Reports pin all reference PNG paths/hashes and reject reference
or shipped-artifact changes throughout capture. Verified QA receipts supply the build revision and
dirty state; the checkout running capture is reported separately. Unreceipted build source is unknown. Store/icon assets (14 frames) require separate artifact
review; unselected, unmapped, recorded-native WebKit, and physical-device evidence remain distinct. Reports: `tests/visual/real/.output/report.md`.
