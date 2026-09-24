---
title: Short-form rush stopped by Still
date: 2026-09-24
status: completed
---

Owner: Zack. Harness: Codex. Branch: `fix/homepage-remove-eyebrow`.

Replace the hero poster with a looping illustration: portrait video cards labelled YouTube Shorts, Instagram Reels, and TikTok rush toward the viewer; the Still mark pops in, freezes the cards, and clears the scene to a calm blue background. Hold the calm state before repeating. The cards are illustrative artwork, not actual social content.

1. Add a lightweight local canvas animation and retain the existing poster without JavaScript.
2. Include pause/resume, a static reduced-motion state, and suspension while offscreen or in a hidden tab.
3. Verify rush, stop, calm, repeat, pause, reduced motion, and responsive sizing in browser tests; inspect desktop/mobile screenshots.

Scope: homepage markup, its styles, one local animation script, and focused browser coverage. No third-party media, network services, tracking, or store changes. Preserve all preceding website edits. References: `STRATEGY.md`, `docs/PRODUCT.md`, and the website source/publication guidance in `docs/README.md`.

Keep the 16:9 frame at every viewport size. A local canvas avoids video download weight; cap rendering resolution and cache card artwork to limit work per frame. Revert the animation-specific markup, script, and styles to restore the poster. Publication remains separate and pending.

Implemented an 11-second loop with 30 illustrative portrait cards: rush for 4.2 seconds, pop in the Still mark and freeze, fade to blue, then hold before repeating. Pause/resume works with the keyboard; reduced-motion visitors see a static logo; offscreen and hidden-tab rendering is suspended; JavaScript-disabled visitors retain the original poster.

Verification: all six focused Playwright tests passed (cycle/freeze, pause/resume, reduced-motion changes, offscreen suspension, mobile frame/control sizing, and no-JavaScript fallback). Targeted ESLint and `git diff --check` passed. Chromium, Firefox, and WebKit each rendered moving canvas frames without page errors. Desktop screenshots of rush, freeze, and calm were visually checked. Physical-device testing was not performed.

Additional owner-directed changes during this work: removed the "A quieter default" and "Quiet infrastructure" eyebrows; replaced the three boxed benefit cards with vertically stacked, borderless rows and static blue SVG illustrations. Desktop/mobile screenshots were inspected and layout checks passed at nine widths in all three browser engines. The proposed non-repetitive hero copy was presented but has not been applied. All work remains local.

The former service-list section now contains separate three-step mobile and desktop setup instructions and a shared optional email-code sync explanation, grounded in `docs/setup.html`. Removed the "Still: free on every supported surface" eyebrow. Setup screenshots were checked on desktop/mobile, with no page overflow at six widths from 320 to 1920px.

Branding/chaos follow-up: owner requested recognizable platform logos and a more chaotic opening. Added locally hosted YouTube Shorts, Instagram Reels, and TikTok SVG marks with provenance in `docs/assets/platforms/README.md`. Each card includes a header logo and a larger center mark. Increased card count from 18 to 30 with varied faster speeds, wider angles, drifting perspective, and speed trails; retained freeze/calm timing. Six cached card textures are shared by the 30 cards. Asset decoding completes before animation starts; a failed asset preserves the poster. All three browser engines loaded the three local assets without page errors; existing six animation tests remain green. A seventh test verifies fallback when a logo fails to load.

Final owner-directed refinements: centered the benefits heading and step copy, tightened vertical spacing, added aligned phone/monitor icons, simplified setup labels and mobile step two, and rounded the setup section. Updated the sync bullet to "Instantly sync your Still settings". Removed the redundant compatibility introduction and final CTA, centered the compatibility heading vertically, and combined Mac/Desktop into one Desktop row. Guide titles now wrap naturally. Earlier notes about retained final badges and unpublished work describe intermediate states.

Publication authorized by Zack on September 24, 2026. Publish the homepage and changed assets from the separate `gh-pages` branch after source verification; preserve the custom domain, public aliases, and unrelated site files. Plans and tests remain in the source repository only.
