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
applies_when: Binding JSONB snapshots, generating dollar-quoted DDL, or comparing query rows
date: 2026-10-07
status: active
symptoms:
  - "A JSONB array reaches the ledger as a JSON string"
  - "A literal SQL closing dollar quote becomes a single dollar sign"
  - "A canonical snapshot projection loses a verified revocation marker"
  - "Identical query rows fail equality because driver statement metadata differs"
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
- Constructing the full driver at module load in an environment-free suite: its connection defaults read environment variables even when no query runs.
- Deep-comparing whole driver `Result` objects: hidden transport metadata can differ between identical query executions.

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

Compare complete returned rows separately from transport metadata. The behavioral SQL probes in
[`scoped_access_rights_test.ts`](../../../supabase/tests/scoped_access_rights_test.ts) and
[`apple_scoped_access_test.ts`](../../../supabase/tests/apple_scoped_access_test.ts) use:

```ts
assertEquals(Array.from(after), Array.from(before));
```

Pinned postgres.js [`Result`](https://github.com/porsager/postgres/blob/v3.4.9/src/result.js) extends
`Array` and carries non-enumerable statement, column and command metadata. Converting both sides
retains every row, field and ordering while excluding those transport properties. Do not replace
this with a first-row comparison or a projection that omits ownership or refund fields.

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

[`pg-access-store.driver.ts`](../../../supabase/functions/_shared/pg-access-store.driver.ts) captures the
production parameter and uses the real pinned driver's JSONB serializer. It checks empty, active,
revoked and mixed arrays, and proves that pre-serialized input becomes a string. The old encoder
and delimiter controls failed; dropping `state` independently failed the revoked-array control.

Keep driver initialization in a required, isolated CI step. Explicit synthetic constructor options
suppress every environment fallback except the driver's unconditional `PGAPPNAME` read. The codec
check passes with access to only that name, without network, file or subprocess permissions; removing
that grant fails at `PGAPPNAME`. The five store logic tests pass without environment access, and the
isolated codec test passes separately. The default handler command retains its existing permissions.
A CI guard executes both commands and fails when the mandatory codec invocation is removed.

```sh
deno test --frozen --config supabase/functions/deno.json supabase/functions/_shared/pg-access-store.test.ts
deno test --frozen --config supabase/functions/deno.json --allow-env=PGAPPNAME supabase/functions/_shared/pg-access-store.driver.ts
```

Static controls extracted the actual production expressions through TypeScript ASTs and executed
their JavaScript for eight migration routines. Of the 32 generated SQL strings, the old version
parsed 24 and failed all eight body controls; the fixed version parsed all 32 with pglast 7.20.
Migration bodies, verifier pins and privileges stayed unchanged. Always validate generated output,
not an equivalent-looking source fragment, and exercise the actual driver codec rather than only
a stub's argument shape.

For all eight repaired row comparisons, controls execute the exact source expressions extracted
through TypeScript ASTs with the real pinned `Result` class and synthetic query outputs. The old
comparisons fail for identical rows with differing statement or connection-state metadata; the fixed comparisons pass.
Changed revisions, statuses, revoked state, missing fields, extra or missing rows, and row order
still fail. No database connection is involved in these controls.

These are local codec, JavaScript, returned-row and grammar checks. They do not establish actual migration 0020
SQL execution, deployed Edge compatibility, provider verification or device behavior.

## Related

[Verify Apple transactions before issuing scoped access](../security-issues/verify-apple-transaction-before-issuing-scoped-access.md).
