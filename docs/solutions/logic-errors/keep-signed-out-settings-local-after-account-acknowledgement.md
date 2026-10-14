---
title: Keep signed-out settings local after an account acknowledgement
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core/src/storage
applies_when: A signed-out settings writer retains field clocks from a previously acknowledged account
date: 2026-10-14
status: active
tags: [settings, atomic-storage, account-isolation, stillkit]
---

# Keep signed-out settings local after an account acknowledgement

## Symptom and cause

After sign-out, a free settings edit could persist `ordering-hold`. Reopening the screen or
reading again returned the same hold, leaving controls unavailable.

Sign-out correctly retired the account anchor and pending requests while retaining saved values
and clocks. The next edit nevertheless used the queueing path with acknowledged revision zero.
A field whose saved base revision was greater than zero rejected that stale ordering input.

## Repair

The TypeScript and StillKit writers save eligible `previous-account` signed-out edits locally.
They retain each field's base revision, advance its local step and never create a transferable
request or an account receipt. Eligibility requires a valid modern record, no account/session,
no anchor, an empty journal, an available sequence and no pause. Existing never-linked first-sign-in
transfer and nonempty journal behavior retain their own rules.

Initialization releases only an `ordering-hold` whose record otherwise satisfies that eligibility.
It advances the durable sequence and preserves settings, clocks, metadata and held choices.
It does not replay an uncertain command. A subsequent deliberate choice can consume its held
overlay. The next account acknowledgement still adopts that account's canonical settings.

The Apple settings view also passes the existing command-unavailable state into its switches,
so a held authority cannot present enabled-looking settings controls.

## Verification and prevention

The original TypeScript regression failed on the first signed-out toggle and on initialization
of a saved hold. The repaired tests cover more than 64 edits, reopening, overlay preservation,
later empty and nonempty account adoption, and rejection of anchored, scoped, queued,
sequence-saturated and future-schema recovery shapes.

`AtomicSettingsLocalOnlyTests.swift` exercises the same cases with native storage and independent
hosts. The shared `atomic-settings-writer-vectors.json` fixture includes an ordering-hold recovery
case, replayed through both writers. Queue-specific tests use never-linked provenance to keep
testing request identity and lock ordering independently of local-only edits.

Do not reset settings or manufacture a cloud acknowledgement to make a local command succeed.
This repair establishes the persisted-state mechanism; real Safari and iPhone lifecycle retests
remain separate from host and temporary-file evidence.

Related: [Lost settings replies](treat-a-lost-settings-reply-as-unknown-and-reread.md).
