# Preview screenshots

Quick visual previews of every approved frame, one PNG per frame, numbered in page order (see `../screens.json`).

- They are **scaled to fit** a 912×540 capture and show the visible part of each frame. Long frames (settings pages) are cut off at the frame's own height, as in the reference page.
- Use them to orient. For pixel comparison, generate exact 2× references with `node --input-type=module - < handoff/capture.script`, which screenshots each frame at its true size into `handoff/reference/`.
- Folders: gallery, d01-desktop-popup, d02-mobile-popup, d03-settings, d04-apple-settings, d12-apple-onboarding, d14-first-run, d18-purchase-restore, d28-rating, store-assets.
