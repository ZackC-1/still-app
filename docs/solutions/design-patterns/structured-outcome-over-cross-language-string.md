---
title: Cross a language boundary with a structured outcome, not a matched message string
category: design-patterns
problem_type: design_pattern
track: knowledge
module: packages/core
tags: [native-bridge, swift, typescript, coupling, enums, wkwebview]
applies_when: A value crosses the Swift↔TypeScript (or any cross-language) bridge and the consumer branches on it
date: 2026-06-24
status: active
---

# Structured outcome over a matched message string

## Context

The native purchase bridge returned outcomes Swift→TS. To distinguish "no offering available" (show a
"try again" state) from a generic failure, the TS controller originally regex-matched the **English
error string** Swift produced:

```ts
// Swift: PurchaseManager returned .failed("no offering available")
// TS controller, reconstructing a distinct UI state from the message text:
if (result.error && /no offering/i.test(result.error)) this.purchaseFlow = "unavailable";
else { this.purchaseFlow = "failed"; this.purchaseError = result.error ?? null; }
```

This is a silent cross-language, cross-process coupling: rename or localize the Swift string and the TS
branch dead-routes to `failed` with **zero compiler help** and no failing test (the test pinned the
same literal, so both sides agreed by accident).

## Guidance

Promote the distinction to a **structured outcome** that is part of the bridge contract, and switch on
it on the consuming side. The error *message* stays free-text for display; the *control-flow signal*
becomes an enum value both sides name.

```swift
enum Outcome { case purchased, cancelled, pending, unavailable, failed(String) }  // Swift
// no package → return .unavailable  (was: .failed("no offering available"))
```

```ts
export type PurchaseOutcome = "purchased" | "cancelled" | "pending" | "unavailable" | "failed"; // TS
case "unavailable": this.purchaseFlow = "unavailable"; break;   // switch on outcome, no regex
```

## Why This Matters

- Control flow no longer depends on a human-readable string staying byte-identical across two
  languages, two processes, and any future localization.
- Adding the enum case surfaces both sides at once (the Swift `switch` and the TS union); the regex was
  invisible to both compilers.
- Free-text `error` is still carried for the genuinely-unstructured failure detail — you only promote
  the cases the UI branches on.

## When to Apply

Whenever a consumer **branches** on a value that crossed a language/process/serialization boundary. Use
free-text only for display, never for `if`/`switch`. The smell: a regex or substring test against an
error/message field that the other side authored.

## Examples

- Fix: `packages/core/src/native/bridge.ts` (`PurchaseOutcome` adds `"unavailable"`),
  `apps/apple/.../PurchaseManager.swift` (`.unavailable` case),
  `packages/core/src/ui/controller.svelte.ts` (`setPurchaseOutcome` switches on it).
