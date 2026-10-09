---
title: Run darwin-only tests locally before merging native purchase changes
category: conventions
track: knowledge
module: packages/core/src/native
applies_when: Changing PurchaseManager, StillKit purchase boundaries or other Swift sources that a TypeScript test compiles with swiftc
date: 2026-10-09
status: active
tags:
  - ci
  - swift
  - testing
  - payments
---

# Darwin-only tests are invisible to CI

Some core tests compile real Swift sources with `swiftc` and synthetic ports, for example
`packages/core/src/native/__tests__/native-purchase-sales.test.ts`, which extracts
`PurchaseManager.purchaseStillPro` and the StillKit sales boundary. They are guarded by
`it.runIf(process.platform === "darwin")`. The main CI lanes run on Linux, so these tests are
**skipped there and a green PR says nothing about them**. The separate StillKit job runs
`swift test`, which does not include them either.

The sandbox pre-charge check (#367) added `requiresSandboxInstallation` and
`verifiedInstallEnvironment` to the real sources. The harness's fakes lacked both, so it stopped
compiling, yet every CI check passed. A later local full `pnpm test` on a Mac found it.

## What to do

- After changing any Swift source that a darwin-only TypeScript test extracts, run the full core
  suite on a Mac (`pnpm --filter @still/core test`), not only CI.
- `grep -rn 'runIf(process.platform === "darwin")' packages` lists the affected tests.
- When a harness fakes a type that gained members, give the fake the same members **and** add a case
  for the new behaviour, so the harness checks it rather than just compiling again.
