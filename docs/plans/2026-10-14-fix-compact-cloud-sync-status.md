# Compact cloud sync status

Status: implemented and locally verified; consolidated integration pending

ISS-0056 asks for the signed-in desktop popup's cloud status and last successful sync date/time
to share a compact line. This branch includes PR #433's presentation work as a dependency;
the reviewed commit joins the consolidated integration change, with no separate PR or merge.

## Scope

- Pass the existing controller timestamp to the desktop popup presentation and render it beside
  the current status, removing the separate timestamp after account actions.
- Keep the current localized date/time format and semantic `time` element. On success, the status
  already explains the timestamp; keep “Last synced” available to assistive technology. Pending
  and failed states retain that explicit visible label so an earlier exchange is not mistaken
  for a successful current upload.
- Let the line wrap at narrow widths and enlarged text; retain alert/status roles and retry.
- Leave sync operations, account lifecycle, options/native layouts, and local agreement UI alone.

## Verification

- Existing maintained popup host regression: the actual timestamp shares the status container,
  reacts to controller changes, remains the last successful exchange during pending/failure,
  disappears when unknown or signed out, and retry/free controls remain available.
- Render the real desktop component at its normal width and at narrow/enlarged sizes. Check
  one-line success at the normal size and no clipping/overflow at constrained sizes.
- Targeted host/component tests, workspace lint/typecheck/build, scoped simplification and review.
- Geometry in a browser harness is not an installed toolbar or physical-device receipt.

## Evidence

- The maintained popup regression failed on the original separate timestamp, then passed with
  the timestamp inside the live status. The focused host, retry and desktop suites pass 77 tests.
- Rendered Chromium, WebKit and Firefox checks cover 380px and 320px widths, text scales 1 and 2,
  and success/pending/failed states (36 combinations). Success fits one line at 380px/default text;
  narrower and enlarged cases wrap without horizontal overflow. Retry and Settings remain reachable.
- Workspace lint, typecheck and build passed. Scoped simplification reused the canonical timestamp
  label; correctness, state-transition, accessibility and geometry review found no source defect.
- Updated the existing visual-contract learning. Installed toolbar/device retest remains separate.
