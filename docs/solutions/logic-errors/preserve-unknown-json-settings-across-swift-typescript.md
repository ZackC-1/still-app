---
title: Preserve unknown settings before cross-language JSON decoding
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core/src/storage
applies_when: Migrating settings between TypeScript and Swift while retaining unknown JSON fields
date: 2026-10-02
last_updated: 2026-10-02
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

## Retained installation provenance

The same absence rule applies to the `still:originalInstall` slot. A failed decoder previously
allowed the next launch to replace retained installation history with today's date. Both
`ensureOriginalInstall` and `OriginalInstall.ensure` now create a record only when the actual
slot is absent. Unreadable nonempty values remain untouched and return an unavailable result.
Assess supported local fields separately from richer optional store metadata; a local date is
not proof of a purchase.

Keep the original representation when comparing eligibility. Browser records store UTC
milliseconds; Foundation's default Codable `Date` stores seconds from January 1, 2001.
Normalize only the assessment projection. Never rewrite the retained date or replace a missing
date with the current time. Missing schemas retain their established version-one meaning;
unsupported schemas and malformed required fields cannot establish eligibility.

The [shared original-record vectors](../../../tests/access-proof/local-protection-vectors.json)
cover sparse records, unsupported and malformed schemas, and timestamps before, exactly at,
and after a synthetic cutoff. [Browser tests](../../../packages/ext-chromium/lib/__tests__/original-install.test.ts)
and [native raw-data tests](../../../apps/apple/StillKit/Tests/StillKitTests/LocalProtectionTests.swift)
verify retained values remain unchanged. Removing either host's nonempty-value guard makes
these tests fail by manufacturing new history. This verifies local preservation and assessment;
it does not establish independently verified store or account history.
