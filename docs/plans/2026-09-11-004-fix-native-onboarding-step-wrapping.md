# Preserve complete native setup instructions

Status: implemented and locally verified; PR review pending  
Owner: Codex Apple release workstream  
Branch: fix/onboarding-step-wrapping  
Created: 2026-09-11

The native Safari setup page truncates numbered instructions with ellipses, including on a large iPhone. Let each instruction keep its proposed width and request enough vertical space to wrap. Preserve the existing scroll area, fixed footer, text, actions and Dynamic Type cap.

This follows [Still strategy](../../STRATEGY.md) and the [release runbook](../release/README.md): reliable activation must work without an account or purchase. The [visual verification guidance](../solutions/conventions/codify-cross-platform-visual-contract-in-tests.md) calls for rendered evidence when source assertions cannot prove layout.

1. Apply the minimal numbered-Text layout modifier.
2. Compile iOS and macOS; run StillKit tests.
3. Inspect complete steps and scroll-reachable Open Settings at normal and larger type on a small simulator; check 320-point geometry in a clearly identified temporary harness if no compatible older runtime exists.
4. Independently review, open a PR, and preserve store artifacts until a separate build-update task.

Local results: both Release builds succeeded; 131 StillKit tests passed. Actual 375-point iPhone SE (3rd generation), iOS 26.5 and a private 320×568-point UIHosting harness rendered full numbered instructions at normal text and the existing accessibility1 cap. Content below the fixed footer remained reachable by scrolling. The harness used the unchanged production view, was not committed, and does not certify an older iOS runtime or physical device.

No pricing, authentication, permission, version or store artifact changes are included. This source change requires fresh Apple builds before users receive it. Rollback is reverting the single Text layout modifier. The reusable fix is recorded in [the solution note](../solutions/ui-bugs/swiftui-numbered-setup-text-truncates.md).
