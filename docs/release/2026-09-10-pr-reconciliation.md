# Still 2.0 PR reconciliation

Verified September 10, 2026 (Pacific). **Source is verified for merge; public release remains No-Go
pending the external and device gates below.**

Artifact/source candidate: `80b4ec63f8649f9c8bbb17fa9b6b99fd8635d166`. Subsequent reconciliation
commits update documentation only. [PR #168](https://github.com/ZackC-1/still-app/pull/168) records
protected integration and final merge status. Historical device evidence keeps its original
artifact attribution; this record supersedes older signing/source claims where fresh evidence exists.

## Review and integration

| PR | Disposition |
|---|---|
| #167 | Domain migration merged first as 7758dc3 |
| #156 | Exact head 8ee95fef already on main; redundant PR closed with ancestry evidence |
| #154 | Export failures return generic errors; real SDK/handler regressions included |
| #158 | Window-bound security counters, hard-delete cleanup, migration 0013 and deployment runbook |
| #155 | Configured popup geometry and both fresh CI capability variants; one shared test flag |
| #159 | Blocking-page logo and aligned switches, retaining newer main UI changes |
| #157 | 2.0.0 shipping versions, Apple build 7, and dated certification documents |
| #145, #165 | Combined dependency updates; both manifests preserved and lockfile regenerated |
| #129, #120 | pnpm action 6.0.9 and setup-node 7; required checks remain enforced |

Every original head is an ancestor of the candidate; merge commits preserve their history. Review
covered correctness, project standards, test fidelity, security, migration/recovery, error handling,
concurrency and Apple build settings sequentially in the main agent, per repository tool mapping.
This is not a claim of independent multi-model review. No remaining source defect was retained.

An additional compatible development-only Undici update from 7.28.0 to 7.29.1 removed the five
advisories left after the dependency PRs. Unit tests were rerun after that patch.

The candidate matches the previously tested local 18dd971 app/backend implementation except for
deliberate domain and dependency updates. All 61 worktrees were inventoried: none had dirty tracked
source. Four older worktrees contain untracked audit tools/cache/evidence and were preserved.
Local configuration and generated artifacts are intentionally excluded from Git.

## Fresh verification

| Check | Result |
|---|---|
| Frozen install, lint, types, all production web builds | Passed |
| JavaScript unit tests | 788 passed; 39 intentional dormant-feature skips |
| StillKit native tests | 131 passed |
| Deno lint, frozen entrypoint check, handler tests | 135 tests plus eight steps passed |
| Disposable PostgreSQL/GoTrue, migrations 0001-0013 | Ten steps passed, including deletion races and real scheduled cleanup |
| Unconfigured browser fixtures | 51 passed; two configured-only cases skipped |
| Fresh configured browser fixtures | All 53 passed |
| Full and production dependency audit | Zero advisories |
| Required GitHub CI on source candidate | All three checks passed |
| Chrome/Firefox packages | 2.0.0, new domain links, four documented host permissions |
| Clean complete-source AMO reproduction | All 20 Firefox runtime files match byte-for-byte |
| iOS/macOS Release archives and App Store exports | Succeeded without upload or provisioning-update flags |
| Nested Apple signatures and versions | Distribution signatures valid; app/extension 2.0.0 (7), debugging disabled; Mac sandbox enabled |

An initial signing-identity inventory omitted distribution identities. Actual exports superseded
that incomplete inventory: iOS uses Apple Distribution with App Store profiles; the Mac installer
uses 3rd Party Mac Developer Installer and nested distribution signatures. The installer's generic
“Development” status label alone does not classify its signing purpose.

## Artifacts and website

Fresh Chrome ZIP, Firefox ZIP, complete AMO source ZIP, iOS App Store IPA, Mac App Store PKG and a
machine-readable SHA-256 manifest are in the ignored local directory
`docs/build/release-gates/artifacts/reconciled-80b4ec6/`. Existing approved public client configuration
was used; no private server/signing key is in the complete-source ZIP. The default WXT partial source
ZIP is not the AMO deliverable. None of these artifacts was uploaded or submitted. Match hashes,
not merely the repeated version/build labels, when choosing packages.

stillapp.fit has valid apex/www DNS, an approved certificate, and HTTPS enforcement enabled.
Homepage, privacy, support, setup, sitemap and robots URLs returned HTTPS 200; HTTP redirects to
HTTPS. Publishing remains on gh-pages, independent of main.

## Remaining public-release gates

1. **Hosted compatibility:** read-only production inventory still showed migrations 0001-0012.
   Apply reviewed 0013 and Edge changes through [counter-retention.md](counter-retention.md), with
   explicit scope and post-deployment evidence. The migration purges legacy counters once and adds
   auth triggers and scheduled cleanup. No production mutation occurred in this reconciliation.
2. **Provider/privacy:** the existing runbook requires actual provider log/backup/deletion-policy
   verification before publishing its privacy draft. Counter-table tests do not establish provider
   retention; this work introduces no new privacy claim.
3. **Device/account journeys:** no fresh physical-device or store-installed journey ran here.
   Final-candidate account, offline/restart, cross-device, accessibility and supported iPad coverage
   must follow the release matrix. Browser fixtures do not establish physical Safari acceptance.
4. **Store rollout:** verify current portal build/version and review status before uploading these
   exact hashes. Coordinate 2.0 free-blocking/optional-sync listing and website copy, privacy/support
   URLs, and store publication. Successful export does not establish submission readiness.

Source integration, repository synchronization, artifacts and HTTPS can complete while these gates
remain open. Do not label this candidate ready for public users without evidence closing them.
