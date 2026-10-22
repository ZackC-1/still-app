---
title: Bind the Supabase pooler writer to the Auth project
category: security-issues
track: bug
problem_type: configuration_error
module: supabase/functions/_shared/production-checkout-runtime.ts
applies_when: Valid Supabase pooler credentials fail a strict database-role configuration guard
date: 2026-10-21
status: active
tags:
  - supabase
  - payments
  - configuration
  - least-privilege
---

# Bind the Supabase pooler writer to the Auth project

An unsigned or incorrectly signed Stripe webhook returning 503 before signature validation can
indicate that checkout runtime composition failed. A working GET method rejection does not prove
that the runtime accepts its credentials.

The production checkout parser accepted only the exact database username
`still_entitlement_writer`. Supabase pooler connections use a project-suffixed username. The
existing credential was valid, but the parser returned null before constructing the webhook
handler. Tests had covered direct-role connections without a representative pooler connection.
Deployment checks that prove a secret exists and that uploaded source matches cannot catch this
configuration incompatibility.

## Preserve the security boundary

Keep the direct-role path. Accept the pooler form only when all of these checks pass:

- The username is exactly `still_entitlement_writer.<project>` and the project matches the
  standard HTTPS Supabase Auth origin. The Auth origin has no nonstandard port.
- The hostname matches the anchored Supabase AWS pooler grammar
  `aws-[0-9]+-[a-z0-9-]+.pooler.supabase.com`.
- The database port is absent, 5432 or 6543, and all existing configuration guards still pass.

Stripping a suffix and comparing only the base role would accept another project's connection.
Testing only for a hostname substring would accept a lookalike domain. Reject other roles,
projects, extra username suffixes, untrusted hosts and unsupported ports explicitly.

## Verify configuration and hosted behavior separately

Compare prepared secret values with hosted secret metadata privately by digest. Supabase CLI JSON
secret metadata exposes that digest in `value`; do not print it or treat it as a credential value.
Compose the parser and full runtime offline using the existing configuration, with a SQL port
that proves zero calls. This distinguishes parser failure from a database or provider failure
without changing production state.

The [regression tests](../../../supabase/functions/_shared/production-checkout-runtime.test.ts)
first failed for a valid same-project pooler connection. The correction passed 17 focused tests
and the full Deno suite of 651 tests and 147 steps, with one separately gated test ignored.
The matrix includes direct and pooled writers, default and supported explicit ports, wrong
roles/projects/suffixes, and host/Auth-origin lookalikes. Comparing the sealed upload bundles
showed changes only in the create-checkout, complete-checkout and Stripe webhook routes.

After the protected deployment verified uploaded bytes and JWT settings, all 13 safe hosted
negative probes passed. Unsigned and currently dated invalid-signature webhook POSTs returned
400 `invalid_webhook`, replacing the startup 503. These checks establish configuration and
signature rejection; they do not establish successful payment, database fulfilment or refund
handling. Do not fabricate a valid live event or purchase to extend that evidence.

See [PR531](https://github.com/ZackC-1/still-app/pull/531), the
[implementation plan](../../plans/2026-10-21-006-production-writer-pooler-compatibility.md), and
[runtime parser](../../../supabase/functions/_shared/production-checkout-runtime.ts).
