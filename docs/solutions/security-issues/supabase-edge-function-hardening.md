---
title: Hardening Supabase Edge Function surfaces — invocation auth, IP trust, and webhook idempotency
category: security-issues
problem_type: security_issue
track: bug
module: supabase/functions
component: payments
related_components: [authentication, background_job, database]
symptoms:
  - "Scheduler-only Edge Function (verify_jwt=false) accepted any anonymous request and ran admin DB reads plus outbound fetches"
  - "Authenticated billing/reconcile endpoints had no application-level rate limit, so one account could trigger unbounded RevenueCat-backed work"
  - "Per-IP rate-limit key trusted the first x-forwarded-for hop, which a direct caller can spoof behind the Cloudflare edge"
  - "Webhook duplicate guard was written AFTER side effects, so a replayed delivery re-ran the RevenueCat lookup and entitlement write"
root_cause: missing_permission
resolution_type: code_fix
severity: medium
tags: [supabase, edge-functions, rate-limiting, webhook-idempotency, revenuecat, cloudflare, cron, x-forwarded-for]
date: 2026-07-10
status: active
---

# Hardening Supabase Edge Function surfaces

## Problem

A security audit of the Still billing/entitlement backend (Supabase Edge Functions) found four
surfaces that assumed a boundary instead of enforcing one: a scheduled function with no invocation
auth, two authenticated endpoints with no abuse limit, an IP rate-limit key that trusted
client-controlled input, and a webhook whose idempotency guard ran after its side effects.
Fixed in PR #70 (four findings, one commit each) plus a review self-heal commit.

## Symptoms

- `selector-canary` ran `verify_jwt=false` with no auth or method check of its own, yet held
  `service_role` DB access and made outbound page fetches — anyone with the URL could trigger it.
- `create-web-checkout` and `reconcile-entitlement` had no application-level rate limit; each
  accepted request performs a RevenueCat subscriber lookup (cost + availability pressure).
- The per-IP limiter keyed on `x-forwarded-for.split(",")[0]` — the first hop, which a direct
  caller can prepend/spoof behind Supabase's Cloudflare edge (evades the cap; can also poison a
  victim's shared-IP bucket to 429 them).
- `revenuecat-webhook` recorded the event id AFTER reconciling, so a replay re-fetched RevenueCat
  and re-wrote entitlement before the duplicate was noticed.

## What Didn't Work

- **A schedule as an access boundary.** The canary relied on "only the cron triggers it." A
  schedule controls *when* something is invoked, not *who* may invoke it — the function URL is a
  public HTTP endpoint. (session history: same fail-safe lesson as
  `gate-production-trust-by-build-mode` — trust must be enforced, not assumed.)
- **Record-after-reconcile for idempotency.** Recording the event only after success keeps failed
  events retriable, but leaves the whole side-effecting path replayable. An earlier iteration that
  recorded *before* reconciling caused the opposite bug — a transient failure permanently skipped
  entitlement (a prior P0). Neither ordering alone is correct.
- **A bare 5-minute stale-claim takeover with no ownership token.** It let a *slow-but-alive*
  worker (Edge wall-clock cap is 400s > 5 min) be taken over, then clobber the takeover worker's
  live claim on its late release.

## Solution

**1. Gate scheduled functions with a static token, same pattern as the webhook.** Extract one
shared constant-time gate and reuse it (fail closed when the secret is blank, POST-only):

```ts
// _shared/token.ts
export function requireStaticToken(req: Request, token: string): Response | null {
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });
  const auth = req.headers.get("Authorization") ?? "";
  if (token.length === 0 || !constantTimeEqual(auth, token)) {
    return jsonResponse(401, { error: "unauthorized" });
  }
  return null;
}
```

The canary's `pg_cron`/dashboard schedule sends `Authorization: <SELECTOR_CANARY_INVOCATION_TOKEN>`.

**2. Rate-limit per user AND per client IP** via a `SECURITY DEFINER` fixed-window RPC granted only
to the narrow writer role (migration `0010`), returning `429` + `Retry-After`. Check the user
bucket first and short-circuit so an already-limited user never consumes an IP slot; a limiter
failure propagates (fail closed), it does not wave traffic through.

**3. Derive the client IP from a trustworthy header, not the first XFF hop.** Behind Supabase's
Cloudflare edge, `cf-connecting-ip` is set to the real socket peer and strips any client copy:

```ts
export function clientIp(req: Request): string | null {
  const direct = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? "").trim();
  if (direct.length > 0) return direct;
  // Fallback: the gateway APPENDS the real IP, so the last hop is trustworthy — the first is not.
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1]! : null;
}
```

**4. Claim the webhook event BEFORE side effects, with an ownership token** (migration `0011`).
`claim → reconcile → complete`, and `release` on failure so retries still work. The claim returns a
per-claim `claim_token`; `complete`/`release` only act on a row whose token still matches, and the
stale-claim takeover (raised to 15 min, above the 400s wall-clock cap) issues a *fresh* token:

```sql
-- takeover invalidates the old worker's token; its late release matches nothing
update public.revenuecat_events
   set claim_token = v_token, claimed_at = now()
 where event_id = p_event_id and status = 'processing'
   and claimed_at < now() - interval '15 minutes';
-- complete/release are token-scoped:
--   ... where event_id = p_event_id and status = 'processing' and claim_token = p_claim_token;
```

## Why This Works

The through-line of all four findings is **enforce the boundary, don't assume it**:

- The canary now proves *who* is calling, not just *when* — the schedule is a trigger, the token is
  the access control (`missing_permission`).
- Rate limits turn "a valid account can do this unboundedly" into a metered, fail-closed operation.
- `cf-connecting-ip` is the one IP the edge sets and a client cannot forge; the first XFF hop is
  attacker-authored, so keying abuse controls on it is self-defeating.
- Claiming before side effects makes replay a no-op; the ownership token makes the crash-recovery
  takeover safe against a slow-but-alive worker, and pinning the takeover interval above the
  platform's hard request cap means a claim old enough to take over provably belongs to a dead
  worker.

## Prevention

- **A cron/schedule is never an access boundary.** Any `verify_jwt=false` Edge Function must carry
  its own constant-time token gate (fail closed) — reuse `requireStaticToken`, don't hand-roll a
  second copy. New authenticated functions that trigger paid/external work should apply a rate limit
  the same way.
- **Never trust `x-forwarded-for[0]` for a security decision** behind Cloudflare/Supabase. Use
  `cf-connecting-ip` (then `x-real-ip`, then the *last* XFF hop). This applies to any IP-keyed logic
  (rate limits, geo, allow/deny), not just this endpoint.
- **Idempotency = claim before side effects + release on failure + a per-claim ownership token.**
  If you add a stale-claim takeover, set its threshold above the platform's max request duration
  (Supabase Edge: 400s) so takeover can only ever fire on a dead worker, and scope
  complete/release by the token so a revived worker can't clobber the new claim.
- **Deploy note:** migrations `0010`/`0011` require `supabase db push`; the canary needs
  `SELECTOR_CANARY_INVOCATION_TOKEN` set via `supabase secrets set` and sent in the schedule's
  `Authorization` header, then a redeploy of the four functions.

## Related Issues

- [gate-production-trust-by-build-mode](gate-production-trust-by-build-mode.md) — same fail-safe
  principle (enforce trust, never assume it) applied to signing-key selection.
- [supabase-signout-leaves-local-session-on-revoke-failure](supabase-signout-leaves-local-session-on-revoke-failure.md)
  — related Supabase auth fail-safe behavior.
- [mirror-fixes-across-parallel-paths](../conventions/mirror-fixes-across-parallel-paths.md) — why
  the token gate was extracted into one shared helper instead of copied into the canary.
- PR #70 (Codex security audit remediation); migrations `0010_rate_limits.sql`,
  `0011_webhook_event_claims.sql`.
