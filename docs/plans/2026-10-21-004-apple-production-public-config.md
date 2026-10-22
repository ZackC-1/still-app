---
title: Apple production public backend configuration
status: implemented
date: 2026-10-21
---

# Apple production public backend configuration

PR 520 supplies public access-proof trust, but its native plist overlay omits the public Supabase
origin and client key. `PurchaseManager.freshSalesPolicy` and `NativeAccountAccessRuntime` require
those fields, so a trust-only archive cannot initialize these purchase consumers.

Use the same explicitly exported `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for both Apple web
builds and all four native plists. Validate the fixed production origin and public credential form,
reject sandbox profiles, write production route selection, and preserve exact plist restoration.
Keep private keys out of this work. Preserve free-release behavior when no access trust is pinned.

Verification: Node tests for malformed/foreign/privileged inputs, no partial plist mutation, exact
restoration and all four plist outputs; Swift integration of the real Node-produced XML with native
session and account-runtime consumers. Run release tooling tests and targeted lint. Final signed
archives and device verification remain with the release session after its screen/image edits.

This branch incorporates PR 520 without modifying that session's checkout. No provider or deployment
mutation is part of this fix. Public key pinning still depends on hosted signer evidence.

Verified against main `bac1539f` plus PR 520: 72 Node trust/Chrome tooling tests passed; after integration,
17 focused trust tests and 33 Swift plist/binding tests passed. The latter execute the actual Node
plist writer and initialize both native consumers for all four targets. Targeted ESLint, Bash syntax
and whitespace checks passed. The separate reproducible packaging suite passed all 20 tests,
including two byte-identical Chrome/Firefox builds and refusal paths. No signed Apple archive,
deployment or live purchase is claimed.

Independent review also reproduced two issues in the incorporated trust tooling. Restoration now
preflights all current plist bytes against their recorded original/generated hashes and preserves
concurrent edits plus backups on divergence. Swift paid-switch parsing refuses expression prefixes
and continuation lines. Eighteen focused Node tests pass with behavioral regressions for both cases.
