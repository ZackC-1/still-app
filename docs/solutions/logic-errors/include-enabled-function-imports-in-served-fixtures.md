---
title: Include enabled function imports in served fixtures
category: logic-errors
track: bug
problem_type: logic_error
module: scripts/backend
applies_when: Preparing a synthetic Supabase function tree with dependencies outside the functions directory
date: 2026-10-07
status: active
tags:
  - supabase
  - fixtures
  - imports
---

A synthetic fixture can pass checks for its substituted access entrypoints while the CLI cannot
start the complete function tree. The pinned Supabase CLI discovers every enabled function and
walks its static imports before runtime startup. A missing dependency in another enabled function
therefore matters even when the test never calls that route.

[prepare-access-fixture.mjs](../../../scripts/backend/prepare-access-fixture.mjs) copied all
Supabase functions but copied external dependencies from only the settings runtime source list.
Both policy entrypoints import `packages/shared-types/src/product-policy.ts`, which is deliberately
outside that settings list. The generated fixture omitted the file. Checking only the three
substituted access entrypoints did not cover those policy imports.

The fixture now copies the unchanged policy grammar alongside the existing settings dependencies.
The production settings source list, policy implementation, enabled-function configuration,
provider substitution, readiness predicates, timing and cleanup remain unchanged. This repairs
the fixture's source tree rather than changing runtime acceptance behavior.

[access-runtime.test.mjs](../../../scripts/backend/access-runtime.test.mjs) requires the copied
policy file to equal its repository source and checks frozen Deno module graphs for both policy
entrypoints. The regression failed with a missing-file error before the copy repair and passes
after it. A separate control using the pinned CLI's actual import walker and extraction helpers
reported two missing-file warnings on the old generated fixture and none after the repair. The
CLI's serving path treats that warning as fatal before container startup. The full access-runtime
Node selection also passes.

These checks establish a reproducible source-closure defect and its repair. They do not establish
the unavailable underlying path in a prior hosted failure, successful served readiness, a live
provider response or device acceptance. Hosted execution must still pass its existing gates.

When the CLI or enabled function set changes, recheck imports for the complete generated tree.
Keep copied dependency bytes tied to the reviewed repository source and test the generated
fixture, rather than relying only on checks against the complete repository checkout.
