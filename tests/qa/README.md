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
pixels. No masks, no reference edits. It prints `SKIPPED` and exits 0 when the private design package
(`STILL_DESIGN_PACKAGE`) is absent. Frames whose state cannot be reached yet are reported `BLOCKED`
with the reason, never as passes. Reports: `tests/visual/real/.output/report.md`.
