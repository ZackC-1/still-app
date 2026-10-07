---
title: Bind QA receipts to isolated source and complete packaged resources
category: security-issues
track: bug
problem_type: security_issue
module: scripts/qa
applies_when: Building a paid sandbox candidate from a dirty checkout without changing shipped flags
date: 2026-10-07
status: active
tags:
  - qa
  - source-identity
  - apple-signing
  - packaging
---

A successful compiler exit does not prove that an artifact contains the source, trust configuration
or signature described by its receipt. A local clone starts from HEAD, so staged deletions can leave
old source in the clone. Inherited Git variables can select another index. Comparing only a webview
entrypoint misses changed scripts, and ordinary signature verification accepts ad-hoc signatures.
Buffered compiler output can also overflow and abort an otherwise valid cold build.

[paid-sandbox-qa.mjs](../../../apps/apple/scripts/paid-sandbox-qa.mjs) snapshots the union of current
index/untracked paths and HEAD paths, strips inherited Git overrides, and represents removed source
explicitly. It hashes JSON-framed path/deletion-or-content-digest/executable entries, avoiding collisions between
literal deletion markers, removed files and binary entry boundaries. After applying that snapshot to
a temporary clone, it requires the clone fingerprint to match before enabling both paid constants
and inserting public sandbox configuration. The original source is checked again on exit. Ordinary
local builds use the same framing but include HEAD files physically retained after index removal,
because those builds compile the working tree directly. The clone preserves executable bits so a
new or modified build script remains executable. Local receipts are deferred until all targets
complete and the working-tree fingerprint is checked again; detected source edits refuse every
selected receipt.

Local and test profiles also require both paid constants to contain their exact false declarations
before starting a compiler, so their receipts cannot mislabel a mixed or paid-enabled source.
Git lists untracked nested repositories and linked worktrees with a trailing slash. The snapshot
excludes those separate workspaces, as Git clone does, while preserving their original files.

The packaged app and extension must contain matching typed configuration. Public anonymous JWT
payloads satisfy the native base64url and size grammar before compilation. Generated webview and
Safari resource inventories must match in paths, sizes and hashes; Safari excludes only the known
native metadata, executable, signature and provisioning entries observed in real Xcode products.
Signed archives must satisfy an Apple certificate anchor and the fixed reviewed signing team for
both bundles. The candidate's project settings must agree with that team. Every paid web target
also checks that generated JavaScript embeds all selected public keys. This is an embedding check;
it does not certify a provider response or device acceptance. Compiler output streams
to the run log; only small structured plist output is captured.

[v3-profile.test.mjs](../../../scripts/qa/v3-profile.test.mjs) reproduces staged deletion, alternate
Git state, fingerprint ambiguity, malformed public configuration and unexpected resources. It also
creates a structurally valid ad-hoc signed bundle and requires rejection specifically at the
codesign requirement check. Four regression cases failed before the first repairs and four before
the follow-up repairs. Executable-mode and malformed publishable-prefix regressions also failed
before their fixes. Removing the source-edit or compiled-trust guard in private copies makes the
corresponding behavioral test fail. Paid-flag refusal and a real nested linked worktree each failed
before their production repairs. The restored profile and release-guard suites passed 65 tests,
including an actual cold offline installation of a local development dependency under the paid
production environment. That install already succeeded with current pnpm before an explicit
`--prod=false` was added; the alleged environment-only omission was not reproduced. These checks
establish source and packaging boundaries; they do not establish a real paid archive, provider
configuration, StoreKit transaction, TestFlight upload or device journey. Those require separate
release evidence.
