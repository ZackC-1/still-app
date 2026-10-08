---
title: Preserve JSONB semantics and literal SQL delimiters
category: logic-errors
track: bug
problem_type: logic_error
module: supabase
component: api_layer
root_cause: wrong_api
resolution_type: code_fix
severity: high
framework_version: postgres.js 3.4.9
applies_when: Binding JSONB snapshots or generating PostgreSQL dollar-quoted DDL in JavaScript
date: 2026-10-07
status: active
symptoms:
  - "A JSONB array reaches the ledger as a JSON string"
  - "A literal SQL closing dollar quote becomes a single dollar sign"
  - "A canonical snapshot projection loses a verified revocation marker"
tags: [postgres, jsonb, serialization, revocation, sql-fixtures]
---

## Problem

JavaScript transformations can change SQL values before PostgreSQL receives them. The scoped
access store pre-serialized a rights array, while generated migration controls lost a closing
SQL delimiter. Fixing the array binding also exposed an optional field that must survive projection.

## Symptoms

The actual driver encoder produced a JSON string instead of an array. Generated body-drift
controls ended in `$;` rather than `$$;`, making eight controls syntactically invalid before
they could test the catalog gate. A projection containing only `key` and `product` omitted
`state: "revoked"`, which the current RevenueCat reader supplies for verified refunds.

## What did not work

- `JSON.stringify(rights)` inside a parameter cast to `jsonb`: the driver serialized the string again.
- A replacement string containing `$$`: JavaScript interpreted it as the replacement token for one dollar sign.
- Projecting only required fields: optional domain fields can carry authoritative negative evidence.
- Parsing manually reconstructed SQL fragments: this bypassed the JavaScript generator that damaged the delimiter.

## Solution

[`PgAccessRightStore.commit`](../../../supabase/functions/_shared/pg-access-store.ts) uses the
supported JSON parameter wrapper on fresh objects, preserving all declared fields:

```ts
this.sql.json(rights.map(({ key, product, state }) => ({
  key,
  product,
  ...(state === undefined ? {} : { state }),
})))
```

The Apple migration fixture also uses `sql.json(array)`. Preserve the optional marker defined
by [`ProviderRight`](../../../supabase/functions/_shared/access-issuer.ts); do not infer an active
purchase by dropping the `state` emitted by the
[RevenueCat reader](../../../supabase/functions/_shared/revenuecat-access.ts).

The actual body-drift generator in
[`apple_access_migration_gates_test.ts`](../../../supabase/tests/apple_access_migration_gates_test.ts)
uses a callback for a literal dollar quote:

```ts
.replace(/\$\$;$/, () => "\n-- body drift control\n$$;")
```

## Why this works

In pinned postgres.js 3.4.9, `json()` supplies JSONB type 3802. The driver's Bind path selects its
JSON serializer after parameter description; passing an already serialized string therefore
encodes a JSON string. A typed wrapper containing the array produces the intended JSON array.
See the maintained [parameter implementation](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js)
and [JSON codecs](https://github.com/porsager/postgres/blob/v3.4.9/src/types.js).

Fresh explicit objects retain `key`, `product` and optional `state` without carrying unrelated
metadata or depending on later mutation of caller objects. A replacement callback returns literal
text; replacement strings intentionally using captures such as `$1` remain a separate valid case.

## Prevention and verification

[`pg-access-store.test.ts`](../../../supabase/functions/_shared/pg-access-store.test.ts) captures the
production parameter and uses the real pinned driver's JSONB serializer. It checks empty, active,
revoked and mixed arrays, and proves that pre-serialized input becomes a string. The old encoder
and delimiter controls failed; dropping `state` independently failed the revoked-array control.
The final focused run passed nine tests, with one hosted SQL test ignored.

```sh
deno test --frozen --config supabase/functions/deno.json --allow-env supabase/functions/_shared/pg-access-store.test.ts supabase/tests/apple_access_migration_gates_test.ts
```

Static controls extracted the actual production expressions through TypeScript ASTs and executed
their JavaScript for eight migration routines. Of the 32 generated SQL strings, the old version
parsed 24 and failed all eight body controls; the fixed version parsed all 32 with pglast 7.20.
Migration bodies, verifier pins and privileges stayed unchanged. Always validate generated output,
not an equivalent-looking source fragment, and exercise the actual driver codec rather than only
a stub's argument shape.

These are local codec, JavaScript and grammar checks. They do not establish actual migration 0020
SQL execution, deployed Edge compatibility, provider verification or device behavior.

## Related

[Verify Apple transactions before issuing scoped access](../security-issues/verify-apple-transaction-before-issuing-scoped-access.md).
