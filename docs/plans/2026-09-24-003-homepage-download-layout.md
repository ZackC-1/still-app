---
title: Simplify homepage hero downloads
date: 2026-09-24
status: completed
---

Remove the opening blue eyebrow and the hero's device-specific download button. Place the four official store badges in one evenly spaced row across the hero on desktop and two columns on smaller screens, with consistent image heights and preserved aspect ratios. Keep downloads before the hero image on mobile. Preserve store destinations, the navigation CTA, and device compatibility notices.

Scope: `docs/index.html` and `docs/assets/marketing.css`. Changes are local for iterative review; publication uses the separate `gh-pages` workflow.

Verification: inspect desktop and mobile screenshots, check badge alignment and horizontal overflow at 320, 390, 768, 1024, and 1440 pixels, and verify navigation targeting and device notes still work.

Completed by Codex on branch `fix/homepage-remove-eyebrow`. Browser checks passed at all five widths: four badges, one desktop row or two narrower rows, no horizontal overflow, loaded artwork, preserved store destinations, and touch targets at least 44px high. Desktop and mobile screenshots were visually reviewed. Android compatibility notice and iPhone navigation targeting passed with device emulation. `git diff --check` passed. Changes remain local and unpublished.

References: `STRATEGY.md`, `docs/PRODUCT.md`, and `docs/solutions/conventions/github-pages-custom-domain-certificate.md`. Reverting the scoped HTML/CSS diff restores the previous layout. No new architectural learning or external changes were required.

## Responsive follow-up

The owner requested reliable scaling across window sizes and mobile. Audit the full homepage at phone, tablet, desktop, and breakpoint-adjacent widths. Improve narrow-screen heading sizes, header spacing, compatibility description width, card padding, and final download badge layout. Preserve image proportions and touch targets. Retain the subsequent owner-requested hero description and removal of the sync caption and showcase eyebrow. Verify the final page in Chromium, Firefox, and WebKit where locally available; use screenshots and layout measurements rather than assuming a media query works.

Completed: Chromium, Firefox, and WebKit each passed all 19 viewport widths from 320 to 2560px, including breakpoint boundaries. Verified no page overflow, offscreen content, internally overflowing text, distorted store badges, or undersized badge/navigation touch targets. Fixed existing viewport-based padding that squeezed the dark and blue split sections on wide screens. Mobile compatibility descriptions now use the full card width; headings scale down and final store badges form two columns. Added the owner's requested "on both mobile and desktop" heading suffix. The Chrome badge now has a white background and subtle rounded border; desktop and mobile screenshots were checked after that cosmetic change. Browser emulation does not replace physical-device testing. Publication remains pending.
