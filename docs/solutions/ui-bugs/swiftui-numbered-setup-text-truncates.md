---
title: Let SwiftUI setup instructions grow vertically inside a scroll view
category: ui-bugs
track: bug
problem_type: ui_bug
module: apps/apple/Still/Shared (App)/Onboarding
applies_when: Numbered SwiftUI instructions truncate with ellipses despite a scrollable parent
date: 2026-09-11
status: active
tags: [swiftui, onboarding, dynamic-type, text-wrapping]
---

# Numbered setup text truncates

The native Safari setup page showed ellipses in its first and third instructions, even on a large iPhone at normal text size. A scrollable parent does not itself require each nested Text to claim its complete multiline height: the numbered HStack accepted a compressed vertical proposal.

Apply `.fixedSize(horizontal: false, vertical: true)` to the instruction Text in `OnboardingView.enableExtension`. Its width still follows the row, so long instructions wrap; its height expands to preserve the complete text. The existing ScrollView makes the additional height reachable, while the footer remains available. Do not fix this by shrinking fonts or limiting lines.

The fix was compiled for iOS and macOS and accompanied by 131 passing StillKit tests. Rendered checks used an actual 375-point iPhone SE3 simulator at normal type and the app's existing accessibility1 cap. A temporary 320×568-point UIHosting harness around the same production view checked narrower geometry. Full numbered text appeared across scroll positions and Open Settings remained reachable by scrolling. The harness was excluded from source changes and is not evidence for an older OS runtime or a physical device.

A source-string assertion cannot establish wrapping or control reachability. When changing this layout, inspect the first and final instructions and scroll to the settings action at normal and larger type; content below the fixed footer is expected to scroll. See [cross-platform visual verification](../conventions/codify-cross-platform-visual-contract-in-tests.md).
