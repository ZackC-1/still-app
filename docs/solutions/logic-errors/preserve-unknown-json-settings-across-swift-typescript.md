---
title: Preserve unknown settings before cross-language JSON decoding
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core/src/storage
applies_when: Migrating settings between TypeScript and Swift while retaining unknown JSON fields
date: 2026-10-02
status: active
tags:
  - settings
  - migration
  - swift
  - unicode
  - preservation
---

# Preserve unknown settings before cross-language JSON decoding

A parser can return valid settings while silently losing data that a newer client understands.
In the preserving migration added by [PR #227](https://github.com/ZackC-1/still-app/pull/227),
three runtime details required regression coverage: Swift dictionary keys compare Unicode
canonical equivalents as equal, the default TypeScript text decoder consumes a leading BOM,
and Swift JSON encoding can expand slash-heavy strings beyond the encoded-byte limit.

## Cause and fix

JSON names `é` and `e\u0301` have distinct encoded names. TypeScript can retain both, but
Swift's `[String: Value]` collapses them. Check the Foundation `NSDictionary` tree for Swift-key
collisions before accepting the Codable result, including dictionaries nested inside arrays.
Return typed recovery with the original `Data` and individually readable settings when the
representation cannot preserve both names. A successful lossy migration is unsafe.

For unknown strings, the TypeScript UTF-8 validation roundtrip uses
`TextDecoder("utf-8", { ignoreBOM: true })` so a literal leading BOM remains content.
Native serialization uses sorted keys and `withoutEscapingSlashes`; otherwise valid input near
the byte bound can be rejected only because the serializer adds escape characters.
Semantic cross-language parity does not imply identical serialized bytes from every encoder.

Keep migration separate from installation and account authority. Only proven fresh provenance
with absent data creates initial defaults. Missing, malformed, future-schema or conflicting
provenance returns recovery; it never proves a fresh install. Preserve original recovery data
and readable Off choices, and do not create deliberate edit steps during migration.

## Evidence and prevention

The original regression runs failed for leading-BOM preservation in TypeScript and for native
canonical-equivalent keys and slash-heavy output. The corrected candidate passed 59 focused
TypeScript settings tests and 23 compiled Swift settings tests, including 27 shared vectors.
Required CI passed before PR #227 landed. These checks establish pure migration behavior;
they do not establish atomic storage, sync, minimum-Xcode compatibility or device behavior.

Keep raw-input native tests alongside shared decoded fixtures: decoding a fixture into a Swift
dictionary before exercising the migration would already lose the collision being tested.
Cover nested objects and arrays, invalid UTF-8, oversized raw bytes and exact recovery-byte
retention. Reuse the packaged registry and shared fixtures rather than duplicating defaults.

Implementation and regression tests:

- [TypeScript migration](../../../packages/core/src/storage/settings-v2.ts) and
  [tests](../../../packages/core/src/storage/__tests__/settings-v2.test.ts).
- [Swift migration](../../../apps/apple/StillKit/Sources/StillKit/SettingsV2.swift) and
  [raw-input tests](../../../apps/apple/StillKit/Tests/StillKitTests/SettingsV2Tests.swift).
- [Shared vectors](../../../packages/shared-types/fixtures/settings-v2.json).
