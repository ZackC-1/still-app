# Still 2.0 candidate certification

Status: **No-Go — implementation complete; release verification blocked**. Issue #153 stays open.

Frozen runtime/source candidate: `d87126aa34d599ee38bb31b2182622a4376a40eb`, based on
`b98f801e7036bac21d0687b18eed0aee88723ee6`. This document records that candidate after packaging;
its documentation commit is not a new runtime candidate. No older artifact or device result is reused.

## Reviewed implementation

| Issue | Draft PR | Reviewed issue head | Result |
|---|---|---|---|
| #149 account lifecycle isolation | #156 | `8ee95fef8df371599c999d0d3b57ca7078961899` | Standards/spec pass; real Swift bridge included |
| #150 export read errors | #154 | `eeb234e34ca3959f9b7f1b817d9cd6f2aacbd0d3` | Standards/spec pass; errors fail closed |
| #151 configured popup | #155 | `1ae5ed30278bf132f9ed90f64123a6394b01309a` | Standards/spec pass; configured CI added |
| #152 retention | #158 | `06ac954ed274dd6c4ab25dbae37274f446f2f415` | Standards/spec pass; production migration/privacy approval pending |
| #153 packaging | #157 | `6c83ef210c84fbdf932a113200c0d5868d216955` before this evidence update | Preparation standards/spec pass; certification gates below |

The local candidate cherry-picks eight reviewed commits, including the provider/deployment-command
corrections. Every source/candidate stable patch ID matches. The combined Supabase adapter retains
both export read-error checks and explicit hard deletion. No dependency or dormant paid-code change.

## Artifact manifest

All shipping marketing versions are 2.0.0; Apple build is 7. Live store build history still needs
verification before submission. Apple app/extension identifiers are `com.chartash.still` and
`com.chartash.still.Extension`; both use `group.com.chartash.still`. Firefox retains
`still@chartash.com`. Browser/Safari host permissions remain limited to YouTube, Instagram,
Facebook and TikTok; no `<all_urls>` or new supported surface.

| Artifact | SHA-256 |
|---|---|
| `still-2.0.0-amo-complete-source.zip` | `6fbd3e8b5cf4597317623c5dda526e92d3f1b8cf00bb66ecfbe7eedaac0787e7` |
| `stillext-chromium-2.0.0-chrome.zip` | `af11e1c4316a6ea79b2164e10bbcd897c9f53537101adc1ecacfbdf8058fff77` |
| `stillext-chromium-2.0.0-firefox.zip` | `2e3ec56f5017986761caae9d42cc78a806d68443bdbd4a90b92295cd5747d2f8` |
| `Still-ios-2.0.0-7-development.ipa` | `c635c4b933c1ff3b5ac921000ee071a4b39d57987b3214ed6b926aa6a5b436a5` |
| `Still-ios-2.0.0-7-development.xcarchive.zip` | `205ddec3526458bf309c87fc91ace072cabcf35372b9ca7ffff7dfc32be463e0` |
| `Still-macos-2.0.0-7-development.app.zip` | `ab1a2643ca14703390950e87ffdc428ab364a05dc44f82e493a06aa05ce029b9` |
| `Still-macos-2.0.0-7-development.xcarchive.zip` | `d2ed3e6ab988d9557aab93c4ff8839c29dc556767003f9481b7b5ece6d87d42a` |

Browser artifacts contain public `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` configuration.
The Apple webview additionally uses the existing public `VITE_REVIEW_SIGNIN_EMAIL` build input;
native Apple configuration uses `REVENUECAT_PUBLIC_API_KEY`. Values are not recorded here.
Safari uses the native bridge. All blocking is free without an account, sync is optional, both paid
flags remain false, and RevenueCat identity remains active with purchase presentation dormant.

The complete AMO submission contains the tracked monorepo, frozen lockfile, public build-config JSON
and `AMO-REBUILD.mjs`/instructions. A clean extraction, `pnpm install --frozen-lockfile`, then
`node AMO-REBUILD.mjs` reproduced all 20 packaged Firefox files byte-for-byte. ZIP timestamps/order
and Apple signing metadata are not claimed reproducible. The WXT-generated partial source ZIP is
not the submitted source artifact. Keep full source and extension ZIP paired; do not rebuild one
with a different public configuration.

Both Release archives and local development exports succeeded using existing **Apple Development**
signing. Deep/strict nested signatures, identifiers, App Groups and 2.0.0 (7) versions passed.
All three webview and 19 Safari resource files match their configured candidate builds. The bundled
1.1.7 rules verify under the existing `still-dev-1` key; the remote production verification key is
configured. Development signing, including iOS `get-task-allow`, is not store distribution evidence.

App Store export failed: no **iOS Distribution** signing certificate. Mac App Store export failed:
no **Mac App Distribution** or **Mac Installer Distribution** certificate. No provisioning updates,
installation, upload, store change or credential change was performed.

## Automated verification

Environment: macOS 26.6.2 (25G83), Node 24.19.0, pnpm 11.9.0, Deno 2.8.3,
Xcode 26.6 (17F113), Apple Swift 6.3.3. Frozen dependency installation; no upgrades.

- `pnpm lint`, `pnpm typecheck`, `pnpm test`: passed; 729 tests, 39 intentional paid-mode skips.
- Fresh `pnpm build` and `pnpm exec playwright test --project=fixtures` passed in each of the
  unconfigured and dummy-public-configured variants: 44 fixtures each. Capability assertions ran.
- Frozen Deno lint/check: passed; all seven Edge entrypoints. Full suite: 135 tests and eight steps.
- Disposable Supabase PostgreSQL/GoTrue auth schema plus repository migrations 0001–0013:
  one retention integration test, ten steps, passed. Includes actual scheduled cleanup/recovery,
  deletion races, preservation, expiry constraints and failed-cleanup retry. Synthetic HTTP deletion
  is backed by real SQL; this does not establish hosted Auth behavior.
- Real `swift test` for StillKit: 125 passed. Both signed Release `xcodebuild archive` operations
  and both local development `-exportArchive` operations passed. Native UI/device testing is separate.
- Independent final Astra/xhigh test-integrity review: PASS. Eight production mutants were killed,
  bytes restored exactly, and final reruns passed. Independent final Astra/xhigh security review:
  PASS for local candidate source and all seven artifacts, with no new send-back defect. Owner-scoped
  API/retention checks and eight nested native signature checks passed. Both reviews explicitly
  retain the production/provider, distribution-signing and native/device No-Go gates.
- Dependency audit is report-only: zero production advisories; 17 development advisory entries
  (nine high, eight moderate) in the unchanged frozen dependency set. No upgrades are included.

Build sequence: fresh configured Chromium/Firefox packaging; configured webview/Safari builds;
sequential iOS/macOS Release archives using frozen resolved packages and existing local signing;
local export with destination `export`, without provisioning updates. Store export uses the checked-in
`apps/apple/scripts/ExportOptions.plist`; development export uses method `debugging`.

## Surface and journey matrix

This matrix records the September 8 candidate test boundaries. **September 11 distribution update:**
Firefox 2.0.0 is now public on AMO; see the [current Firefox release record](03-firefox-amo.md#current-distribution-status--verified-september-11-2026).
Public availability does not itself verify a store-installed signed-XPI host run or the other
journeys below. Those test boundaries remain separate from distribution status.

PASS below names the executed boundary. **Unverified** remains a release gate; fixture rendering
is not a claim of native Safari, live websites, physical devices or two-device account testing.

| Surface | Candidate evidence | Remaining host gate |
|---|---|---|
| Chrome / Chromium desktop | Exact packaged ZIP loaded unpacked in Chromium149.0.7827.55 on macOS26.6.2; actual toolbar light/dark380×600, content589.578px. Synthetic four-site offline/control/restart journeys and embedded options passed;320/375px, keyboard Tab and24px text/scroll passed | Store-installed distribution, live-site, screen-reader and account/two-device certification remain unverified |
| Firefox desktop | Exact packaged ZIP temporarily installed in Firefox155.0.1 on macOS26.6.2; actual toolbar light/dark380×595, content594.567px. Synthetic four-site offline/control journeys and restart with same-ID reinstall passed.320/375px, native keyboard Tab and24px text/scroll passed | Store-installed signed AMO host run, native inline options controls, screen-reader, live-site and account/two-device journeys remain unverified in this candidate audit |
| macOS app + Safari | Signed Release archive and development app export; exact WKWebView/Safari resources and App Group signatures verified | Actual isolated native WKWebView/Safari execution, App Group propagation, restart/background journeys |
| iOS app + Safari | Signed Release archive and development IPA; embedded resources/signatures verified | Physical iPhone installation and native/Safari sheet/pages, background/restart and larger-text coverage |
| iPadOS app + Safari | Same 2.0.0 (7) signed candidate | Physical supported iPad coverage unavailable/unverified |

The browser journeys use committed synthetic service documents with external traffic blocked.
They verify ordinary YouTube/Instagram/Facebook content remains and TikTok is blocked as a whole
website. Chrome options were exercised in the actual embedded host; Firefox opened `about:addons`
and separately exercised the installed options document, leaving its nested host controls unverified.
Firefox layout used native text input for Tab traversal after initially focusing the first control;
this establishes the tested keyboard path, not complete screen-reader or native inline-host coverage.
Legacy stored pauses were seeded on all four services and verified ignored in both actual artifacts,
matching the intentionally removed pause UI. No pause feature or dormant behavior was changed.

Required outstanding native/device journeys: fresh install with no account/purchase; offline blocking
on all four services and ordinary-content preservation; master/per-service controls, legacy-pause normalization, persistence,
restart and sign-out with continued blocking; narrow widths, both themes, keyboard/accessibility and
larger text. Browser fixture and synthetic hosted-extension evidence does not complete these native rows.

Account lifecycle, account-wins, delayed-response, offline and retained-marker behavior have automated
synthetic seam evidence. End-to-end new/existing account adoption, two devices editing/reconnecting,
A → B → A, deletion/re-creation and sign-out require isolated local/staging or explicitly approved
synthetic accounts. Production account creation, OTP delivery, session/profile writes or deletion
were not used as smoke tests and are not authorized by this record.

## Backend compatibility and release actions

The candidate requires backend code from `d87126aa34d599ee38bb31b2182622a4376a40eb` and migration
**0013**. Read-only hosted inventory verified only 0001–0012; the retention implementation is not
live. Follow [counter-retention.md](counter-retention.md) for exact preflight, approved legacy purge,
cron/grants, `supabase functions deploy --import-map supabase/functions/deno.json`, verification and
forward-only recovery. Do not restore raw-IP counters during recovery. Review the
[privacy draft](privacy-retention-draft.md) before publication.

The permitted shared-network exception lasts only through its existing throttle window. Under
successful database/scheduler operation, maximum counter retention is 665 seconds including cleanup
delay. Outages, SQL DELETE versus storage reclamation, WAL, backups and provider logs are explicitly
separate. Auth OTP templates/settings and backup/config inventory were read successfully, but that
does not verify maximum provider retention, deletion, effective SQL parameter logging, SMTP or
RevenueCat spend/rate controls. Retained sign-in logging can still send raw request IPs to provider
logs; the counter migration does not remove those copies. Resolve that logging/retention mismatch
and historical provider copies before treating the deletion/privacy requirement as satisfied.

| Outstanding action | Owner | Concrete next step / completion evidence |
|---|---|---|
| Distribution signing | Founder | Make the existing team's iOS/Mac distribution and Mac installer identities available with approval; rerun local exports on the frozen archives, inspect nested signatures and record new hashes |
| Native/device coverage | Founder + verifier | Supply isolated Mac/Safari and unlocked test iPhone/iPad, identify approved synthetic account environment, then run the exact candidate journeys above and record OS/browser/artifact evidence |
| Provider policy and controls | Founder + backend verifier | Verify logs, SQL parameter logging, backup/WAL deletion/retention and SMTP/RevenueCat limits/spend; resolve mismatches before approving privacy language |
| Backend deployment/purge | Founder + backend operator | Approve the reviewed 0013/deploy/runbook effects and recovery, apply in the documented order, then record deployed function/schema and post-deployment verification |
| Privacy/store text | Founder | Review the retention draft and prepared free-blocking/optional-sync store drafts; mobile wording must explicitly mean websites in Safari, not native social apps |
| Integration/release/submission | Founder + release operator | Approve exact scoped PR merges/release-branch changes and subsequently exact distribution artifact hashes/store actions; verify live store version/build history first |

No issue is closed by this record. No release-branch push/merge, production write, migration/purge,
privacy publication or store submission has occurred. Green automated checks and development-signed
exports alone do not authorize a Go decision.
