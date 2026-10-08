---
title: Bind QA receipts to isolated source and complete packaged resources
category: security-issues
track: bug
problem_type: security_issue
module: scripts/qa
applies_when: Building a paid sandbox candidate from a dirty checkout without changing shipped flags
date: 2026-10-07
last_updated: 2026-10-08
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
both bundles. The candidate's project settings must agree with that team. Chrome and Firefox also check that generated JavaScript embeds all selected public keys.
The Apple webview checks only real inline module bodies in its executed index.html entry; an
unused assets chunk or another HTML file cannot satisfy it. Reuse the candidate's existing
jsdom/parse5 development dependency after the isolated frozen install. Run that parser in a
separate Node process with an empty environment and bounded input, output and runtime, rather
than importing candidate dependencies into the operator verifier's realm. This separates
environment and JavaScript globals; it is not an operating-system filesystem sandbox.

Scripting-enabled HTML parsing excludes comments, templates, noscript, raw text, external-script
bodies and attribute impostors. Browser extension targets do not accept inline modules. Safari
resources delegate verification to the native host and are explicitly marked
sandbox-native-authority-unverified with sandboxProofAccepted null; source resources alone do
not establish compiled native authority. Native targets still require the existing compiled
app/extension plist and complete resource checks. These are embedding and packaging checks;
they do not certify a provider response or device acceptance. Compiler output streams
to the run log; only small structured plist output is captured.

Recognizing a supported environment reference does not authorize it as a store-package input.
[package.mjs](../../../scripts/release/package.mjs) classifies `VITE_ACCESS_ENVIRONMENT` and
`VITE_ACCESS_PUBLIC_KEYS` as QA-only references while retaining its public store-input allowlist.
Ordinary store packages strip ambient QA trust values, reject explicitly requested QA trust inputs
before creating output, and omit them from AMO rebuild instructions. Unknown and private variable
names remain errors. Adding these names to the public allowlist would bypass that boundary; a
future production trust configuration needs its own reviewed release change.

[release.test.mjs](../../../scripts/release/release.test.mjs) checks reference classification,
ambient stripping, explicit refusal, empty output on refusal and omitted rebuild instructions.
Private negative controls remove the classification or admit QA trust into the public allowlist;
both make the corresponding check fail. The restored complete `pnpm test:release` command passes,
including byte-identical repeated Chrome/Firefox packaging. These release-script checks do not
establish live access verification, a configured backend or device acceptance.

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

The October 8 parser regressions also reject keys present only in orphan JavaScript or a different
HTML document. A synthetic candidate parser sees no operator environment sentinel and cannot
modify the parent verifier's globals. Restoring the previous helper makes both controls fail.
The 25-test focused suite passes with the corrections. A fresh isolated source clone with an
actual frozen offline development install accepts the previously built webview index.html alone;
no compiler or provider operation ran during that check. Preliminary six-target packages remain
bound to their original clean 3c4a08aa source receipt and must not be relabelled as a later helper
commit or as signed, installed or payment-ready artifacts.
