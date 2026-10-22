---
title: Web canonical purchase analytics from the consenting originating device
status: implementing
created: 2026-10-21
---

# Web canonical purchase analytics

## Problem and boundary

The production payment ledger is authoritative, but `purchase_recorded` and
`purchase_refunded` have no producer. Access refreshes, restore outcomes and checkout returns
cannot establish a sale. Existing analytics subjects establish identity and erasure state;
they do not establish current device permission. Turning sharing off deliberately sends
nothing, so a webhook cannot safely forward optional analytics from an old subject.

This increment covers signed-in production web purchases on Chrome and Firefox. It adds no
new event names, properties, browsing data, revenue amounts or provider identifiers to PostHog.
Payment fulfilment must continue when analytics is unavailable. Production sales stay off
until the independent release gates clear.

The next increment covers Apple purchases. Native `.purchased` currently also represents an
already-owned preflight, so it must expose actual newly purchased transaction provenance before
any sale reporting can be correct. Anonymous Apple must preserve the existing origin/erasure
contract without repurposing RevenueCat's `appAccountToken` or linking anonymous history to an
account. Neither Apple completion nor an anonymous attribution design is claimed here.

## Immutable original attribution

The existing create-checkout request may include a closed optional analytics value containing
only the originating device's origin proof and PostHog project-key hash. The analytics client
provides it only after the normal fresh permission/account fence, from the ordinary purchase UI.
The private consent origin, erasure key, email and PostHog identity do not travel in this body.

After preparation, `production_claim_checkout_with_analytics` wraps the existing creation
claim in the same transaction. Only the winning creation request may bind its existing active
subject; the claim's account and operation locks serialize competing devices and retries. A
nested exception block drops optional attribution errors without rolling back the payment claim.
The server admits the proof only when its project-key hash matches the configured project.
Surface/build come from existing admission inputs. Binding is immutable and unique per operation.
A checkout started without attribution cannot acquire it on retry or later opt-in. The final
browser fetch adapter captures permission after SDK authorization, with a 250ms bound; missing,
malformed, stale or timed-out analytics leaves functional checkout available.

## Current device reporting

An ordinary Still screen can call a new `analytics-purchase` route only while the existing
analytics client has freshly re-read the same granted permission and current account scope.
It sends the origin proof and project-key hash, using the account's verified session and the
client's cancellation signal. Sign-out, deletion or withdrawal fences dispatch exactly as
other optional analytics work. No background purchase webhook sends analytics and no work is
held waiting for permission. A new permission origin cannot report the previous origin's
purchases. A different device cannot authorize them.

The server resolves the subject from authenticated account plus proof; it does not accept a
client-supplied subject, transaction, event name, timestamp, amount or outcome. It selects only
that subject's immutable attributions and reads the production operation ledger. A canonical
paid timestamp with a bound live Stripe session admits one `purchase_recorded`; the canonical
full-refund status admits one `purchase_refunded`. Sandbox, review, unpaid and unbound records
are excluded. Restore, linked access and entitlement snapshots never enter this route.

A fresh server erasure/ownership check immediately precedes forwarding. Subject retirement or
account deletion suppresses subsequent work. Provider delivery already in flight retains the
existing erasure worker's finite 35-day late-write sweeps. Each request dispatches at most two
events within four seconds, with one-second provider attempts and ten-second token leases. A withdrawal learned by the client cancels
the request; a server cannot learn an offline switch change, and no blanket server-consent lease
is inferred. The device request is the sole current-consent dispatch opportunity.

## Storage, idempotency and deletion

Migration `0028_purchase_analytics.sql` adds a private attribution/dispatch table with a foreign
key to the analytics subject and operation, fixed web surface, and fixed randomly generated
UUIDs per sale/refund event. Timestamps come from the immutable canonical ledger observation:
`paid_at` for the sale and optional `refunded_at`, frozen by a first-refund status-transition
trigger from the canonical update timestamp, never reporting time. A later recovery bind can
change the ledger’s `updated_at`; it cannot change the frozen refund time. Optional trigger
failure drops that refund report without rolling back payment processing. Deletion of the subject cascades the optional mapping;
the payment record remains under the existing financial retention rule. Device/account erasure
retires the subject, so every prepare/report path checks retirement and erasure fences. Retired
mapping rows cannot recreate a subject or move history to another account.

A short dispatch claim excludes concurrent duplicate sends. Completion/release compares its
claim token and unexpired lease, so a stale worker cannot clear a successor. If a full refund
already exists on first report, the sale precedes the refund. Partial refunds do not produce the
full-refund event or remove rights. A provider failure releases it;
a lost successful response retries the same UUID, distinct ID, event and timestamp. A successful
response records completion. PostHog receives only the existing closed event properties plus
the established envelope and pseudonymous subject. It receives no operation/session/provider IDs.
No arbitrary event payload, activity log or outbox is stored in Supabase. The narrow role exposes
only fixed RPCs, with RLS/private-schema boundaries and bounded queries.

Reporting is a consented subset, not accounting: purchases without original attribution, purchases
whose original device never returns with the same permission/account, and refunds after withdrawal
will not appear. The dashboard must state this. Actual payment/refund truth remains in Supabase
and payment providers independently.

## Implementation ownership

- SQL migration and disposable database tests for attribution/claims/erasure/permissions.
- `supabase/functions/analytics-purchase/` handler and production runtime.
- Shared optional checkout attribution hook; no change to QA route admission or payment outcomes.
- Existing browser analytics host/account scope and purchase wiring; no content-script producers.
- Protected deployment catalogue/bundler and related tests for the fixed new function.
- Closed-schema provider adapter, immutable deduplication and failure-injection tests.

Independent design review by the parent and analytics verification agent approved this web slice
on 2026-10-21, with shared claim/bind locking, token CAS, finite dispatch bounds and erasure
fences incorporated. Apple remains a following slice. Hosted database and release-device evidence
remain outstanding until recorded below.

## Required verification

1. No original permission, stopped permission, wrong project, wrong device, retired subject,
   changed account or late registration emits nothing and does not block checkout.
2. A real canonical production paid operation reports once; retries/concurrent calls keep the same
   event identity. Pending, expired-unpaid, restore and review paths report nothing.
3. Canonical refund uses the original attribution; current permission from another device or a
   new origin cannot authorize it. Missing sale attribution never gets backfilled by refund.
4. Off during the last asynchronous consent/session read fences dispatch; off/on does not revive
   previous origin work. Erasure/account deletion suppresses dispatch and removes optional mapping.
5. Provider outage and claim expiry are retryable while current consent is independently checked;
   payment fulfilment is unchanged by analytics failure.
6. SQL role/grant/RLS/adversarial tests, Deno handler/runtime tests, actual browser factory tests,
   closed bundle checks, and final production-device delivery/erasure evidence remain separate.

## Verification checkpoint (implementation in progress)

- Workspace typecheck: passed, zero errors/warnings.
- Lint: passed.
- Canonical analytics / production checkout Deno tests: 21 passed. The hosted-only SQL test
  is deliberately skipped locally; this is not database proof.
- Six client tests passed, including the actual Supabase Functions fetch adapter and stale
  permission/account suppression. Full analytics suite initially had one Apple timing-sensitive
  negative-control failure; its isolated 35-test file passed. Baseline reproduction is underway;
  coverage and application behavior have not been weakened.
- Deployment and bundle unit tests: 29 passed, three integration-gated tests skipped in that run.
- Protected analytics deployment now includes the fourth route and requires the 0028 structural
  gate. The subject switch redeploys both identify and purchase handlers on every reapplication:
  matching secret bytes alone cannot prove a previous partial rollout loaded that setting.
- Full bundle integration, disposable SQL, PR checks and independent implementation review pending.

## Deployment switch correction and verification

Independent review found that checkout caches its optional analytics configuration at startup.
Changing the secret alone does not stop or start original attribution on an already warm instance.
The protected switch plan now binds a separate five-route bundle catalogue, all migration bytes,
and the shared closed purchase deployment prerequisites. Normal analytics function deployment
continues to deploy only the four analytics routes. Switch enable checks payment history and all
purchase secret names before any write, then refreshes identify, purchase reporting and checkout
using the exact planned bytes with readback. No payment secret is changed by this operation.

Emergency disable writes false and refreshes both reporting workers before checking the payment
prerequisites for checkout refresh. If those prerequisites or its upload/readback fail, the durable
receipt reports `outcome-unknown`; it does not claim attribution collection has stopped. Repairing
prerequisites and repeating the same approved plan refreshes all three runtimes even if the secret
already equals false. Existing in-flight requests remain bounded by the reporting deadline; browser
cancellation is best effort and does not guarantee cancellation of deployed edge work.

Verification at the first implementation commit: the hosted disposable production-ledger rehearsal
(run 39705655857) passed migration 0028 structural/preservation checks and real SQL concurrency,
retirement, lease/CAS and account-erasure scenarios. Local Deno: 642 passed, one database-only test
ignored; typecheck, lint and full build passed. The full analytics suite passed 430 tests after
replacing three fixed 10ms waits in Apple negative-control fixtures with bounded condition waits.
The untouched main baseline bac1539f failed the same full suite at the adjacent Apple late-identity
assertion, while its isolated file passed; all positive and negative assertions remain. This is a
fixture scheduling correction, not a change to Apple application behavior. Hosted production
verification and actual default-on browser delivery remain release evidence gates.

The switch correction passed 18 analytics deployment tests, 17 purchase deployment tests and
9 production runtime tests, including actual off/on/off runtime recomposition. The real sealed
bundle integration rebuilt the switch catalogue twice from different paths and passed the existing
startup probes. CI also exposed a separate Apple fixture's fixed 50-turn wait before checking held
launch-event attribution; its final wait now observes the exact expected condition with a bounded
timeout, retaining all identity and event assertions (35 focused Apple tests passed). The earlier
CI Deno lint failure was a test callback's unnecessary async declaration; corrected without runtime
changes. A broad local test run was stopped under shared-machine contention after an unrelated
AppleSettings timeout; full-suite completion must be taken from the new CI run, not that local run.
