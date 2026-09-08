---
title: Codify cross-platform visual parity as file-content assertion tests
date: 2026-07-10
category: conventions
track: knowledge
module: packages/core/src/ui
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "A visual/branding change (font, color, layout) must propagate identically across parallel surfaces: ext-chromium, ext-safari, the WKWebView app shell, and docs pages"
  - "Reviewing a PR that touches Style.css, legal.css, tokens.css, or a popup/options entrypoint mirrored across platforms"
  - "Deciding between manual cross-surface review and an automated regression for platform-parity guarantees"
tags: [visual-parity, cross-platform, design-contract, testing, branding, mirror-fixes, css-zoom]
status: active
---

# Codify cross-platform visual parity as file-content assertion tests

## Context

Still's UI ships to six sibling hosts that must look and feel like one product: the Chromium extension popup/options, the Safari extension popup/options, the WKWebView shell, the SwiftUI onboarding flow, and the docs legal pages (`privacy.html`/`support.html`). Each is built by a different toolchain (Svelte build, static HTML, WKWebView-loaded HTML, SwiftUI, plain docs site) with no shared pipeline that would mechanically keep them in sync — so drift is structurally likely, not just a discipline lapse.

Before PR #69, the contract these hosts shared — same self-hosted Inter font, dark-mode and reduced-motion support, no popup-breaking CSS `zoom` — was enforced only by manual review. That is the same failure mode [[mirror-fixes-across-parallel-paths]] names for teardown logic: parallel paths drift silently until someone exercises the neglected one. And the drift was real, not hypothetical (session history): the shared design token already *named* Inter, but no font file was ever shipped, so each host silently fell back to a different system font; native onboarding used `#3B4FFF` while the shared UI and app icon used `#2A47E8`; and the popup's `zoom: 0.7` was discovered to be masking genuine two-axis overflow rather than fixing it.

## Guidance

Codify the cross-platform visual contract as file-content assertion tests: read each surface's real source file off disk in a unit test and assert on literal substrings/regexes it must (or must not) contain. This is deliberately not visual/rendering testing — it is a fast, deterministic proxy that catches the specific regressions parity reviews were tacitly checking for. Trimmed from `packages/core/src/ui/__tests__/design-contract.test.ts`:

```ts
const read = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

it("self-hosts Inter and defines system dark and reduced-motion modes", () => {
  const tokens = read("src/ui/tokens.css");
  expect(tokens).toContain("@font-face");
  expect(tokens).toContain('font-family: "InterVariable"');
  expect(tokens).toContain("@media (prefers-color-scheme: dark)");
});

it("uses explicit compact popup layout instead of scaling the interface", () => {
  const chromium = read("../ext-chromium/entrypoints/popup/index.html");
  const safari = read("../ext-safari/entrypoints/popup/index.html");
  expect(chromium).not.toMatch(/\bzoom\s*:/);
  expect(safari).not.toMatch(/\bzoom\s*:/);
});
```

Write the contract tests RED-first (session history): the implementing session wrote failing tests for the two named gaps — no explicit compact host mode existed, and service controls stayed keyboard-operable while visually disabled — confirmed RED, and only then implemented.

Two companion practices reinforce the contract:

1. **No CSS `zoom` for compact layouts.** `zoom:` has inconsistent cross-engine coordinate/hit-testing behavior and breaks automation. Instead `App.svelte` exposes a `data-density="compact"` attribute that swaps a block of CSS custom properties — same DOM, same coordinate space, different token values:

   ```svelte
   <div class="still-ui app" data-density={compact ? "compact" : "comfortable"}>
   ```

2. **A rendered-outcome backstop at the real size.** `tests/playwright/extension.spec.ts` loads the *built* popup at 380x600, which is the width Still asks for and the tallest a browser-action popup will ever show, waits for fonts, and asserts computed `zoom === "1"`, no horizontal overflow, and that a key control is wholly in view without scrolling to it. Height is asserted two ways, because either measure alone is satisfied by a popup nobody can use: the document's scroll height catches content outgrowing the 600px cap, and the furthest laid-out bottom edge catches the opposite mistake of pinning the popup's height and letting `overflow: clip` swallow the surplus, which the first measure reports as a clean 600. The narrow-screen checks load the Safari bundle as well as the Chromium one, because the two carry different copy and copy is what decides how wide a popup wants to be; both run in Blink, so they cover the Safari *build*, not the Safari engine.

3. **An absolute width and a percentage maximum for a popup, never a viewport unit.** A browser-action popup has no viewport to measure before it exists: the browser derives the popup window's width from the content's own preferred width, so a relative width is circular. Measured on real toolbar popups, `inline-size: 100%` renders a 69px sliver in Chromium and `min(380px, 100vw)` renders 295px, which was a shipped bug. The rule is narrower than "keep the width absolute", though: a `max-inline-size: 100vw` on top of a correct 380px width collapses a real Firefox popup to 5px with 48 clipped elements and its switches unreachable. What holds is that the width must be an absolute length *and* any maximum must be a percentage, which resolves against the containing block rather than the viewport and so never feeds back into the measurement pass. `max-inline-size: 100%` measures the full 380px on a desktop toolbar, changing nothing there, and lets the same document fit the 320pt phone screen where the extension presents as a sheet. This is why the contract test bans viewport units anywhere in the popup's styles rather than only on the width.

## Why This Matters

String-assertion tests catch cross-surface drift at unit-test speed (milliseconds, no browser) and run in CI on every PR, converting a reviewer's "did you check the other surfaces?" checklist item into something that fails the build automatically.

They are also intentionally cheap, and the blind spots matter:

- They check that source text is *present*, not that it *resolves* — a broken `url("./assets/InterVariable.woff2")` path still passes.
- They only guard what they assert: the duplicated branding CSS on the legal pages was found by an ad-hoc diff pass *after* the contract tests were green (session history), and the brand color hex values duplicated across `tokens.css`, the Apple extension's `Style.css` (a build-time artifact — no committed source to
  assert against), and `docs/assets/legal.css` are not covered.
- Actual font loading (e.g. `document.fonts.check("16px InterVariable")`) is verified only for the extension popup, by the Playwright test's font wait — not by this suite.

Treat the contract test as the floor, and extend its assertions whenever a new invariant is worth defending.

## When to Apply

- Two or more sibling surfaces (web, native, extension, docs) are expected to share a visual or behavioral contract (typography, color scheme, dark mode, layout invariants, disallowed CSS properties) and no single build step guarantees it.
- Parity has so far been enforced only by manual review or tribal knowledge ("remember to check the Safari version too").
- A regression in one surface — someone reintroduces `zoom:` as a quick fix, or drops the dark-mode media query — would be easy to miss because the surfaces are edited independently.
- Extend to a real rendering check (Playwright etc.) when the property cannot be verified from source alone: computed layout, overflow, in-viewport-ness, actual font resolution.

## Examples

- **Before:** a developer changes the Safari popup's HTML and forgets the Chromium popup mirrors it; nothing fails until a reviewer or user notices. **After:** `design-contract.test.ts` reads both popup entrypoints and fails CI if either reintroduces `zoom:`, if the docs pages stop linking `legal.css`, or if `tokens.css` drops its dark-mode block.
- **Before:** compact popup sizing via `zoom: 0.7`, which scaled hit-test coordinates inconsistently across engines and masked real overflow. **After:** `data-density="compact"` toggles CSS custom properties, and the Playwright regression pins the built popup at 380×600 with `zoom === "1"` and zero overflow.
- A worthwhile rejected alternative (session history): standardizing on native system fonts per host was considered and reversed because the product spec requires variable Inter; the accepted trade-off (self-hosting adds ~352 KB per extension bundle, ~880 KB native) was made explicit in the PR description alongside the OFL license packaging.

## Related

- [mirror-fixes-across-parallel-paths](../conventions/mirror-fixes-across-parallel-paths.md) — the manual "check the sibling path" discipline this convention automates for rendered surfaces. Neither supersedes the other: that doc's fix is a shared code path; this one's is a CI-enforced contract for codebases that cannot share code.
- [codify-store-asset-compliance-in-tests](codify-store-asset-compliance-in-tests.md) — the same pattern extended to a non-UI surface: an App Store asset governed by an *external* compliance spec (Apple Guideline 2.3.2) rather than internal cross-surface consistency. Answers this doc's own "extend to a real rendering check when the property cannot be verified from source alone."
- `packages/core/src/ui/__tests__/design-contract.test.ts` — the contract test.
- `tests/playwright/extension.spec.ts` — the rendered-outcome backstop.
