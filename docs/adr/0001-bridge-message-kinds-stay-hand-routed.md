# ADR-0001: Bridge message kinds stay hand-routed (no cross-language schema/codegen)

Date: 2026-07-01 · Status: accepted

## Context

The WKWebView `still` message port carries ~9 message kinds (`get`/`set`, auth/purchase actions,
`get`/`setEntitlement`), typed as a TS union (`NativeMessage` + the storage adapter's shapes) and
routed by a single Swift `switch` in `WebBridgeRouter` (+ the two-lane check in
`SafariWebExtensionHandler`). Adding a kind requires coordinated edits in web, native, and router —
architecture reviews have twice flagged this as HIGH-severity cross-language coupling and suggested
a shared schema / codegen seam.

## Decision

Keep hand-routing. A schema/codegen pipeline (or runtime contract validation layer) would cost more
than the coupling it removes at this scale: the kind set is small, changes rarely (twice since U17),
and every addition is exercised by StillKit bridge tests + core bridge tests on both sides of the
wire. The "atomic multi-file edit" is the cheap part; the expensive failures (shape drift) are
covered by the existing parse-reject tests (`BridgeRequest.parse`, `EntitlementRequest.parse`
return nil on unknown/malformed → callers ignore).

## Consequences

- New kinds follow the documented checklist in `WebBridgeRouter.swift`'s header comment: TS union →
  Swift router case → handler lane (if Safari-reachable) → tests on both sides.
- Revisit if the kind count grows past ~20, a third native host appears, or a shape-drift bug
  escapes the parse tests — that's the signal the seam earns its codegen.
