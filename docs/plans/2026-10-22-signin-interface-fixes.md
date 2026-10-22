---
title: Implement selected sign-in interface review findings
status: complete
date: 2026-10-22
---

# Selected sign-in interface fixes

Owner authorized findings 2, 3, 4 and 5 from the October 22 better-interface review. Base: origin/main 3d344ce5. Branch: fix/signin-interface-20261022. Other findings remain outside this change.

## Implementation

- Keep the full sign-in recipient visible at 320px by wrapping long addresses.
- Apply the existing --text-scale consistently to the shared sign-in sheet, with a 1× fallback and unitless line heights. Keep inputs shrinkable at 2×.
- Use a dedicated input-boundary token in existing light/dark token definitions. Measured candidate values: #7d859f on white 3.67:1; #5d6789 on #0b0f1a 3.43:1. Do not change decorative separators.
- Add native forms for email and code submission. Keep invalid/incomplete, busy and rate-limited states guarded; secondary actions never submit. Retain existing consent and code/magic-link capability behavior.

## Verification

- Component tests with the real UiController: submit email/code, invalid/incomplete values, in-flight duplicates, rate limits, change-address/cancel/skip actions.
- Chromium and WebKit: Enter with valid/invalid email/code; narrow long recipient; light/dark fields unfocused; text scales 1/1.35/1.5/2; overflow, keyboard dismissal/focus return and axe checks.
- Repository lint, typecheck, unit, build and fixtures checks, recording exact outcomes and any environmental limitations.
- Inspect final diff and update the existing measured-text-scale solution with the modal inheritance lesson.

## Evidence

Implemented in the shared `SignInSheet.svelte` and both existing token definitions. Four focused
component tests exercise the real controller with synthetic auth services. The form submit handlers
and buttons share the same disabled predicates; resend/change-address buttons have explicit
non-submit types. Existing consent and magic-link behavior is preserved.

| Finding | Result | Measured evidence |
| --- | --- | --- |
| 2: long recipient overflow | Address wraps without truncation | At 320px, recipient and sheet scroll widths equal their client widths at every tested scale |
| 3: partial text scaling | Heading, labels, fields, actions and status text use the existing scale | Heading 22→44px, label 14→28px, input/action 16→32px at 1×→2× |
| 4: faint input boundary | Dedicated input token uses existing palette values | Unfocused light 3.67:1; dark 3.43:1, up from 1.25:1/1.35:1 |
| 5: Enter does nothing | Email and code steps use native forms | Enter advances valid values; malformed email/incomplete code do not submit; controller tests cover pending and rate-limit guards |

Browser verification: `node docs/build/interface-review/verify-fixes.mjs` passed all 16 combinations
of Chromium/WebKit, light/dark, and scales 1/1.35/1.5/2 at 320×568. Checks include font sizes,
unfocused input contrast, overflow, Enter submission, Escape dismissal, keyboard focus return, and
zero axe WCAG A/AA violations in the code-error dialog. Light 1× and dark 2× screenshots were also
visually inspected. The preview uses actual components with synthetic auth; it does not replace
physical iPhone/iPad verification or a real authentication delivery test.

Local evidence: `docs/build/interface-review/evidence/after-verification.json` and `after-*.png`.
A copy is in the original checkout's `docs/build/interface-review-20261022/evidence/`.

- `pnpm lint`: passed, including a final targeted lint after test edits.
- `pnpm typecheck`: passed (zero Svelte errors/warnings).
- Focused App/sign-in lifecycle/component suites: 44 passed, 21 pre-existing skipped;
  the final expanded four-test form suite also passed.
- `pnpm build`: passed.
- `pnpm test`: passed, 7,195 tests and 40 existing skips across workspace and root suites.
- `pnpm exec playwright test --project=fixtures`: passed, 370 tests and 37 existing skips (8.6 minutes).
- `git diff --check`: passed. Only the four authorized findings, regression tests and their notes changed.

The first full unit attempt encountered a missing generated `packages/ext-safari/.wxt/tsconfig.json`
in the fresh worktree. Typecheck/build generated it; the isolated failing storage test then passed.
This required no application-code change. Full unit verification was restarted afterward.

Delivery branch: `fix/signin-interface-20261022` in `/private/tmp/still-interface-review-20261022`.
The owner authorized publication and merge after local verification. Final merge status and required
CI results are recorded in the associated pull request. Store submission, native-device installation
and external authentication remain outside this change.
