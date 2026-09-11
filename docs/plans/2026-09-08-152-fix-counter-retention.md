# Security counter retention

Status: implemented; independent review and hosted release gates pending. Owner: Codex/Astra. Branch: `fix/152-counter-retention`.
Created: 2026-09-08. Base: `b98f801e7036bac21d0687b18eed0aee88723ee6`.

## Outcome and boundaries

Issue #152 approves short-lived IP-derived security counters after account deletion, only through
existing throttle windows. Remove raw counter identifiers; delete account-linked counters atomically
with auth deletion; automatically remove expired rows even without returning traffic. Preserve the
local last-synced-account marker and every existing caller's limits/response contracts. No dormant
paid-code changes, dependency updates, production writes, privacy publication, or provider changes.

Read: STRATEGY.md, docs/ARCHITECTURE.md, existing Supabase hardening solution. The approved release
policy governs this bounded privacy change. #150 owns export reads in the shared adapter.

## Approved seams and work

1. Real limiter + PostgreSQL RPC: reproduce raw keys, then verify window-specific keyed identifiers,
   finite persisted expiry, unchanged shared-network limits, cleanup without returning traffic.
2. Real delete handler + Supabase adapter with synthetic HTTP backed by local SQL: same/new IP,
   repeated/nonexistent account, unauthorized requests, cleanup/auth failures, unrelated preservation.
3. New forward migration: synthetic legacy purge, least-privilege checks, transaction-safe account
   cleanup, actual scheduler execution. Use local clock control only in the disposable test database.
4. Mutate production cleanup/expiry protections; prove regressions fail and restore exact bytes.
5. Draft privacy language and approval-gated deploy/dry-run/recovery runbook; inventory provider gaps.
6. Frozen Deno checks/tests and independent review before committing/pushing delivery.

## Design and operational limits

Keep the existing limiter RPC interface. Use random per-window HMAC keys and indexed expiries, with
an owner-only cleanup job every minute. Auth deletion cleanup runs in its own database transaction,
so cleanup failure also fails account deletion. Do not add an account-to-IP history. Current window
lengths are 60 and 600 seconds; normal cleanup delay is at most the next minute plus job execution.
Database/scheduler downtime and backups cannot be covered by an unconditional deletion guarantee.
Deployment must verify scheduler health and provider settings before publication; no production
purge/deployment is authorized by this plan. Recovery moves forward and never restores raw counters.

## Evidence

- Baseline real limiter stored the synthetic IP; the new privacy assertion failed before migration.
- Frozen Deno suite: 125 passed. Deno lint: 40 files passed. Deno check: all seven entrypoints passed.
- Disposable PostgreSQL 17.6, Supabase image 17.6.1.166, GoTrue 2.196.0 schema migrations; repository
  migrations 0001–0013. Real SQL counter rows, identities/profile/entitlement preservation, same/new
  IP, repeated/nonexistent/unauthorized deletion, cleanup/auth failure and retry, both lock-observed
  deletion races, finite persisted expiry, and actual scheduled cleanup are covered by the fixture.
- Production cleanup removal failed the expiry and cleanup-recovery steps; removing the expiry
  constraint failed the constraint step. Mutation source restored byte-for-byte. A repeated old-email
  counter after an email change also failed before owner preservation was added.
- A synthetic infinite-window insertion was accepted before adding the finite-time constraint;
  the regression now requires rejection.
- Independent review, hosted deployment/purge, provider retention verification, and public notice
  publication remain separate release gates. No hosted write, OTP, provider change, or publication.

The deployment runbook and privacy draft live under docs/release; reusable learning is captured in
`docs/solutions/security-issues/window-bound-security-counter-retention.md`. Exact local commands,
logs and restoration hashes are retained in ignored release evidence, with no customer data.
