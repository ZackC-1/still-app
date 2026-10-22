---
title: Production writer pooler compatibility
date: 2026-10-21
status: verified-locally
owner: Codex production session
---

# Production writer pooler compatibility

## Confirmed cause

The production Stripe webhook returned 503 before signature validation after the reviewed
nine-route deployment. Private read-only comparisons confirmed the prepared payment settings
match hosted metadata and the existing writer connection uses a Supabase pooler username with
the production project suffix. No credential, URL, digest or customer record is retained here.

`readProductionCheckoutConfig` accepted only the direct username `still_entitlement_writer`.
It rejected the existing pooler form, so checkout composition returned null and the webhook
answered unavailable. Existing configuration tests used only direct-role URLs; the deployment
operation checked that the historical writer secret existed, without parsing its value.

## Bounded implementation

- Preserve the existing exact direct-role path and every other configuration guard.
- Admit the suffixed writer only when its suffix exactly matches the project in the HTTPS
  Supabase Auth origin, the pooler hostname matches the existing Supabase AWS pooler grammar,
  and the database port is the default, 5432 or 6543. Nonstandard Auth ports are refused.
- Reject elevated or different roles, other projects, extra suffixes, untrusted hosts and host
  lookalikes. Never authorize a username by splitting off its first component.
- Keep the change inside the production checkout parser and its existing focused tests.

## Verification

The regression first failed because the valid same-project pooler configuration did not compose.
After the parser correction, all 17 production checkout/runtime and Stripe webhook tests passed.
The matrix covers accepted direct and pooler forms, both pooler ports, default port, and the
negative role/project/host/Auth cases above. Composition performs zero SQL queries.

Changed Deno sources pass lint; the create, complete and Stripe webhook entrypoints typecheck.
Private offline validation also composes the prepared payment configuration with synthetic
same-project pooler and Auth inputs, with zero SQL calls. This validates configuration parsing
without touching a production account or provider.

The complete existing Deno suite passes: 651 tests and 147 steps, zero failures, one separately
gated test ignored. A second private check uses the original local writer/Auth configuration
(whose writer value was independently matched to hosted metadata) with the prepared payment
configuration: both the parser and full runtime compose, with zero SQL calls.

The existing sealed compiler boundary compiled both closed deployment sets before and after the
change. All five analytics uploads are byte-identical. Only three purchase uploads change:
`create-web-checkout`, `complete-web-checkout` and `stripe-webhook`; the other six are unchanged.

Hosted verification remains a separate protected deployment: inspect the new exact source receipt,
then require unsigned and incorrectly signed webhook requests to return 400 instead of 503.
Keep the production Stripe endpoint disabled until its remaining readiness gates are satisfied.
No valid synthetic production event or purchase is part of this correction.
