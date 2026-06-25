---
title: Gate production signing-key trust by build mode, not by key presence
category: security-issues
problem_type: security_issue
track: knowledge
module: packages/ext-safari
tags: [signing-keys, rule-set, trust, ed25519, fail-safe, extension]
applies_when: Selecting which signing/trust keys a client honors, where dev and prod keys both exist
date: 2026-06-24
status: active
---

# Gate production trust by build mode, not key presence

## Context

The Safari extension verifies fetched signed rule sets against a trusted-key allowlist. Two key sets
exist: `DEV_RULE_SET_KEYS` (the dev-signed seed, for local end-to-end testing) and
`PRODUCTION_RULE_SET_KEYS` (empty until a human publishes prod keys — a deploy-only secret).

A tempting selection rule is *"use prod keys when non-empty, else fall back to dev keys."* That is a
**privilege-escalation footgun**: a production build that ships before prod keys are populated would
fall back to trusting the **dev key** — whose private half lives in a throwaway constant in
`scripts/sign-seed.mjs`. Anyone could then sign a malicious rule set the production extension accepts.

## Guidance

Select the trusted-key set by **build mode**, never by whether prod keys happen to be populated:

```ts
// A prod build trusts ONLY prod keys (empty → nothing verifies → bundled seed used).
// The dev key is NEVER reachable in a prod build.
export function ruleSetTrustedKeys(prod: boolean): readonly TrustedKey[] {
  return prod ? PRODUCTION_RULE_SET_KEYS : DEV_RULE_SET_KEYS;
}
```

Then make "no trusted keys" **fail safe**, not fail open: with an empty prod allowlist, the fetch
verifies nothing and the client falls back to the bundled (signed-at-build) seed. Shipping before prod
keys exist degrades to "no runtime updates," never to "trusts a weaker key."

```ts
// no endpoint, or no keys for this build → skip the fetch entirely; bundled seed applies
if (!input.endpoint) return null;
const allowedKeys = ruleSetTrustedKeys(input.prod);
if (allowedKeys.length === 0) return null;
```

## Why This Matters

Gating on key *presence* couples a security boundary to a deploy-ordering accident. Gating on build
*mode* makes the dev key categorically unreachable in production — the property you actually want —
and is independent of whether the prod keys have shipped yet.

## When to Apply

Any client that picks between development and production trust material (signing keys, pinned certs,
JWKS, allowlisted issuers). The rule: the production build's trust set is a fixed function of the build
mode; the dev set must be unreachable there even when the prod set is empty. Empty trust set →
fail-safe fallback, never fall through to a weaker set.

## Examples

- `packages/ext-safari/lib/rule-set.ts` (`ruleSetTrustedKeys`, `ruleSetFetchConfig`).
- The deploy procedure that fills the prod gap: `docs/production-rule-set-keys.md`.
