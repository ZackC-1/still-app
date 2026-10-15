---
title: Release idle QA sync connections between notification bursts
status: in_progress
date: 2026-10-15
---

# Release idle QA sync connections between notification bursts

Hosted verification of PR440 proved faster delivery, but sustained edits exposed a remaining
connection-capacity problem. Fifteen bounded read-only samples showed idle settings-writer
connections rising from six to29 during12 edits while other role counts stayed stable.
The earlier repeated campaign recorded SQLSTATE53300 and HTTP500/503 responses; its13 functional
scenarios passed, but final restoration exceeded30 seconds. Both test profiles were subsequently
restored. Do not treat that campaign as fully passing.

## Scope

Keep one connection per Edge instance. Shorten only the QA settings handler's idle retention from
20 seconds to one second, so idle connections are released before the five-second fallback poll.
Ordinary functions keep their existing default; no database role, schema, credential, policy,
settings protocol, retry, transaction or blocking behavior changes. The .361 client package remains
the exact unchanged artifact from d1c61f75. This follow-up changes backend behavior only.

## Verification and delivery

1. Exercise the QA handler's one-second lifetime selection in existing unit tests.
2. Prove on disposable PostgreSQL that eight independent idle clients close, reconnect successfully,
   and retain active transactions; the ordinary20-second client stays connected.
3. Run Deno and relevant deployment/rehearsal checks, review the diff locally, merge through the
   protected branch, then prepare the exact QA function deployment and its protected approval gate.
4. Re-run .361 timing, notification-loss, offline recovery and bounded capacity observation; require
   successful final restoration and report any remaining backend errors. Shorter lifetime is a
   hypothesis until the hosted repetition confirms its effect.

Owner authorization covers necessary sandbox work. GitHub owner gates remain mandatory. Do not
deploy ordinary production functions or change the frozen candidate to synchronize its version.

## Evidence

Operational evidence is under the local owner-QA campaign `automation-sync-20261015`. Initial
notification timing median2014ms versus5853ms fallback; direct binary-frame observation verified
38 hints at each peer. Notification suppression proved fallback and restoration. No customer data
or credentials are retained. Final hosted results are pending.

Local verification: all582 Deno tests passed (143 steps, one existing ignored test),11 QA runtime
unit tests passed, lint/typecheck passed,136 deployment checks passed (four integration cases
reserved for CI). The real disposable PostgreSQL test passed: eight idle clients released, the
ordinary client remained open, a released client reconnected, and its active transaction survived
the idle interval. Code review: skipped (ce-code-review unavailable); inline correctness, deployment
scope and resource-cleanup review completed. Independent external source export remains prohibited
by the recorded automatic approval review rejection. Hosted proof remains pending.
