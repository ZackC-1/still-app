---
title: Bound security counters to disposable windows and auth deletion transactions
category: security-issues
track: bug
problem_type: security_issue
module: supabase/functions
applies_when: Retaining abuse prevention across account deletion without keeping raw IP history
date: 2026-09-08
last_updated: 2026-09-11
status: active
tags: [privacy, retention, rate-limiting, postgres, account-deletion]
---

# Window-bound security counters

The original fixed-window limiter stored raw user/email/IP keys. It removed stale rows only when
the same bucket returned. Account deletion called GoTrue and cascaded settings/entitlements, but
counters had no account foreign key. Two accounts sharing an IP shared one counter; deleting UUID
keys or the deletion request's current IP could not erase historical IP use accurately.

The approved policy permits shared connection protection only through its existing short window.
Migration `0013_counter_retention.sql` derives stored keys with a random HMAC secret per fixed
window, adds finite expiry constraints, and deletes window keys/counters automatically through an
owner-only minute cron job. No account-to-IP association is introduced. Legacy raw counters are
purged once rather than assigned an invented expiry.

Account counters have a cascading foreign key. Consume holds a key-share lock on an existing auth
user; it refuses nonexistent UUID subjects. Account creation/email triggers attach earlier
review-email counters, and deletion removes remaining current-email buckets. Email lookup and
account transitions serialize with an advisory lock without storing email history. Cleanup failure
rolls back auth deletion, preserving a retryable account rather than creating an orphan cleanup task
after credentials disappear. PostgreSQL can abort a lock conflict; callers must remain fail closed.

The RPC interface and limits stay unchanged. The Postgres adapter drops parameter-bearing driver
errors before handler logging and rejects missing RPC results. Do not propagate an error `cause`
that reintroduces raw parameters into logs.

Counter minimization must include application logs. The review-sign-in handler previously wrote
raw request IPs for every verification outcome, including non-review and unconfigured refusals,
and passed provider exceptions to `console.error`. It now logs timestamps and fixed outcomes;
limiter/session-mint errors emit only fixed categories. The limiter still consumes IP-based buckets.
Historical network attribution from application audit messages is intentionally removed; no
authentication or throttle decision depends on those messages. Provider-generated request logs and
already-retained application logs remain separate retention concerns.

`supabase/functions/review-signin/handler.test.ts` checks all verification outcomes and request/verify
limiter failures with synthetic IPv4/IPv6/forwarded headers and exception message/cause/token
sentinels. It asserts response compatibility, safe log fields and fixed error categories. The new
24-step matrix failed against the prior handler and passed after removing sensitive fields. Keep
these output-boundary assertions alongside the existing IP-throttle tests; sanitizing only the
database adapter cannot protect logs emitted elsewhere in the handler.

Verification uses `supabase/tests/rate_limit_retention_test.ts`: real limiter, real persisted SQL
rows, migration, narrow-role checks, lock-observed concurrent deletion, controllable database clock,
real scheduled cleanup, synthetic auth HTTP backed by actual SQL deletion, and cleanup failure/retry.
Focused adapter regressions verify fail-closed behavior. This seam was explicitly approved to query
persisted rows; a mock counter or computed expiry alone cannot prove physical row removal.

Normal deletion is bounded by the remaining 60/600-second window, minute scheduler interval and
five-second successful job budget. A dead scheduler/database cannot honor an absolute wall-clock
erasure guarantee. SQL DELETE also does not securely erase MVCC tuples, WAL or backups. Provider logs
and backup retention must be inventoried separately, and privacy publication must wait for verified
provider limits. See [deployment and provider inventory](../../release/counter-retention.md) and
[privacy draft](../../release/privacy-retention-draft.md).

Prevention: test never-returning buckets, preserve shared-IP controls through account deletion,
exercise both lock orderings, and require a successful scheduled run rather than merely checking
that a cron row exists. Recover forward without restoring purged raw counter data. Do not change
unrelated billing-event retention or the local last-synced-account safety marker as a side effect.
