---
title: Extract security-critical Swift decision logic into StillKit for swift test coverage
category: architecture-patterns
problem_type: architecture_pattern
track: knowledge
module: apps/apple
tags: [swift, testing, stillkit, wkwebview, security, spm]
applies_when: Adding or hardening logic in the Apple app target (Shared (App)/*) that you want unit-tested
date: 2026-06-24
status: active
---

# Extract security-critical Swift decision logic into StillKit

## Context

The Still Apple app's executable Swift (`apps/apple/Still/Shared (App)/*` — `ViewController`,
`WebBridgeRouter`, `PurchaseManager`, `SignInWithApple`) lives in the **Xcode project**, not in an SPM
package, and the project has **no app-target XCTest bundle**. It also imports WebKit / RevenueCat /
AuthenticationServices, which `swift test` cannot link standalone. The result: app-target Swift is
only verifiable on-device in Xcode — there is no CI gate for it.

This bit the App Store submission-readiness work (PR #8): the P0 native-bridge trust boundary (U3) is
security-critical and needed a real test, but `ViewController`'s `WKNavigationDelegate` and message
handler can't run under `swift test`.

## Guidance

Extract the **pure decision** out of the app-target type into the `StillKit` SPM package (Foundation
only), and have the app-target glue call it with values pulled off the live framework objects. Then
unit-test the pure function with `swift test` (runs in CI, no device).

`StillKit` is already structured for exactly this — its `Package.swift` notes it stays Foundation-only
"so the storage bridge is unit-testable from the terminal (`swift test`) with no signing, devices, or
Xcode targets."

**The U3 example:** the trust decision became `BridgeTrust` in StillKit —
`isTrusted(isMainFrame:url:bundledURL:)`, `allowsNavigation(to:bundledURL:)`,
`opensExternally(_:)` — pure `URL` logic with 12 unit tests (path traversal, sibling-prefix collision,
remote origin, nil URL). `ViewController` stays a thin adapter:

```swift
// ViewController (app target, untestable) — just pulls values and delegates the DECISION:
guard let bundled = bundledIndexURL,
      BridgeTrust.isTrusted(
        isMainFrame: message.frameInfo.isMainFrame,
        url: message.frameInfo.request.url,
        bundledURL: bundled)
else { replyHandler(nil, "still: untrusted frame"); return }
```

## Why This Matters

- The load-bearing security logic (what counts as a trusted origin, path-containment) gets real,
  fast, CI-enforced coverage. A future refactor that reintroduces a traversal/prefix bug fails a test.
- The thin glue that remains (`frameInfo.request.url` → `BridgeTrust`) is shallow enough that on-device
  smoke testing is sufficient for it.
- It keeps `swift test` green in CI as the gate for the part that can be gated.

## When to Apply

Reach for this whenever app-target Swift contains a **decision worth testing** — a guard, a
classification, a state-transition rule, an allow/deny — even if the surrounding type imports WebKit/
RevenueCat/StoreKit. Extract the decision (inputs → verdict) to StillKit; leave the framework plumbing
in the app target and flag it for on-device verification.

Counter-case: don't extract logic that is *only* framework orchestration (no branch worth asserting) —
that just adds indirection. The signal is "is there a branch a test could pin?"

## Related

- The complementary gap: app-target types like `PurchaseManager.reset()`/gate and the SIWA
  `.inProgress` guard were **not** extracted and remain on-device-only — a follow-up is to either add an
  app-target XCTest bundle or extract their pure state checks the same way.
- `apps/apple/StillKit/Sources/StillKit/BridgeTrust.swift` + `Tests/StillKitTests/BridgeTrustTests.swift`
