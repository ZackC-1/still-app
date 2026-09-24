# Usage analytics, download attribution and revenue check (Still 2.1)

Status: in progress, all code units implemented; review and owner release steps remain
Owner: Claude Code / founder-directed
Created: 2026-09-23
Source branch: `feat/usage-analytics`

The owner approved this plan on 2026-09-23 after choosing full per-person analytics, on by default
with an off switch (Firefox asks first), and no "how did you hear about Still" question.

## Context

The owner can't tell who downloads Still, which store they came from, whether they signed in, whether they
use more than one version (iPhone, Mac, Chrome, Firefox), or where the money from Apple purchases went.
Today Still collects nothing beyond sign-in email and synced settings, and the homepage promises
"no behavioral tracking." The owner has chosen **full per-person analytics** and is willing to update the
privacy policy. Decisions confirmed:

- **Per-person usage analytics**, linked to the account email when someone signs in.
- **Tracking is on by default with an off switch** (a short notice during setup plus a "Share usage data"
  switch in settings). **Firefox is the exception:** its rules require asking first, so Firefox stays off
  until the person agrees.
- **No "How did you hear about Still?" question.** Where people came from will only be known in
  totals, from store dashboards, tagged website links and website analytics.

**What the owner must be able to answer (the acceptance test for this work):**

| Question | How it's answered |
|---|---|
| New installs each day, by store (iOS, macOS, Chrome, Firefox) | The `installed` event carries `surface`. PostHog chart: daily installs by surface. Check it against Apple's daily download report (needs the Sales key, see Step 0) and the Chrome and Firefox dashboards. PostHog counts the first *open*, so a download that's never opened only appears in the store's own number. |
| First-time user or already installed somewhere else | `installed.returning = true/false` plus person property `surfaces` (see "Recognising the same person" below). |
| Started creating an account / created one / signed into an existing one | Sign-in funnel events (see event list). |
| Who is actively using Still | Daily `active` per install and person, plus a retention chart. |
| Link each of those back to the store they came from | Every person has `first_surface` (the store of their first install) and `surfaces` (every store since), so each chart can be split by the store they first downloaded from. |
| Where the conversion flow loses people | Funnel: installed → setup_completed → sign_in_opened → code_requested → account_created/signed_in → active on day 7. |

- Things to keep: Still never records browsing history (no web addresses, video IDs, page titles or
  anything from the content scripts). Access to the four sites stays unchanged. Blocking never needs
  an account. No advertising use, so Apple's "Allow tracking?" pop-up isn't needed.

Current store state (checked 2026-09-23 through the ASC API): iOS 2.0.0 is live, macOS 2.0.0 is in review,
and the `still_sync` purchase is approved. This work ships as **2.1.0** after 2.0 is out on all four stores.
Don't touch any build that's currently submitted.

## Step −1: Review what the PostHog wizard changed (the owner is running it now)

The owner is running PostHog's setup wizard (`npx @posthog/wizard`). Once it finishes:
- Read `git status` and `git diff` to see every file it added or changed (package.json files, lockfile, any
  new init/provider files, `.env*`).
- **Keep:** the PostHog project and its public project key. Store the key as `VITE_POSTHOG_KEY` in the
  ignored local env files, and put only the variable name in `.env.example`.
- **Undo inside every app and extension package** (`packages/*`, `apps/apple`): the `posthog-js` dependency
  and any code that sets it up. It downloads extra code from the internet (Chrome and Firefox reject that)
  and records every page automatically, which would include the YouTube and Instagram pages Still runs on.
  Replace it with the small Still client described below. Undo only what the wizard added, and leave
  anything else that was already there.
- Check that no secret (a personal API key) ended up in a tracked file. If one did, move it out and tell the owner
  to rotate it.
- The website can use PostHog's normal web snippet (see Website below), but make sure it's the snippet
  version, not one that loads extra code we can't review.

## Step 0: Where the money went (read-only, do first)

- **Apple:** every App Store purchase was paid to Apple. Apple subtracts its commission and pays you by bank
  transfer once a month, once your balance passes the minimum payout amount and your banking and tax
  details are complete. **Tried 2026-09-23:** the existing key (App Manager role) got **403** on `salesReports`, so it can't see sales. Fix: The owner (as Account Holder or
  Admin) creates a second, read-only API key with the **Sales** role, adding **Finance** for payouts
  (App Store Connect → Users and Access → Integrations → App Store Connect API → +), and saves the .p8 to
  `~/.appstoreconnect/private_keys/`. Then run SALES/SUMMARY monthly (June 2026 onward) and FINANCIAL
  reports, and summarize units, earnings and payouts by month. Meanwhile, the owner can look directly in
  App Store Connect → Payments and Financial Reports.
- **RevenueCat:** only keeps purchase records and never holds money. Check its transaction list (dashboard or the v2 API)
  to see which store each purchase came from.
- **Stripe:** only matters if any purchase shows up as RevenueCat Web Billing. The repo has no record of
  Stripe ever being connected for live payments (`docs/release/04-revenuecat.md` checklist is unchecked). Confirm, and
  if Stripe is connected, check its balance and payouts.
- Record a short, privacy-safe summary (no amounts per person) in `docs/release/`.

## Design

**Analytics service: PostHog Cloud (US).** It's free up to 1M events a month and gives the owner ready-made
dashboards, funnels, retention charts and a page per person showing their email. **Don't bundle the
posthog-js SDK:** it loads code from the internet, which Chrome and Firefox don't allow in extensions, and
it records pages automatically. Instead, build a small client of our own that sends a fixed list of events
to PostHog's `/batch/` endpoint using fetch. That works the same everywhere: the extension's background
worker, popups, the Apple app's web view and the Safari extension.

**New module `packages/core/src/analytics/`**, alongside `sync/` and `storage/`:
- `events.ts`: a fixed, typed list of events and the only details each one may include. Every event
  carries `surface` (`chrome|firefox|safari-ios|safari-macos|app-ios|app-macos`), `store`
  (`ios|macos|chrome|firefox`: where that copy was downloaded) and `app_version`. No free-text or
  web-address details are allowed.
  - Install and lifecycle: `installed {returning}`, `updated {from,to}`, `opened {where: popup|options|app}`,
    `active` (at most once a day per install).
  - Activation: `setup_step {step}`, `setup_completed` (Mac: the Safari extension is really enabled,
    checked through `SFSafariExtensionManager`; iPhone: the first event from the Safari extension;
    Chrome/Firefox: at install, since blocking works from then on; popup opens are the separate `opened`
    event), `service_toggled {service, enabled}`, `global_toggled {enabled}`.
  - (Removed by owner decision: a per-service daily `blocking_worked`. It would be browsing history.)
  - Sign-in funnel: `sign_in_opened`, `code_requested`, `code_failed {reason: wrong|expired|rate_limited|network}`,
    `sign_in_abandoned` (sheet closed before verifying), `account_created` (sent by the server once per new account),
    `signed_in` (every successful sign-in), `signed_out`, `account_deleted`. New vs existing is decided on the server
    from the account's creation time, returned by the verify step, so no email is involved.
- `client.ts`: saves events and sends them in batches, holds them while offline and retries later, and sends
  nothing when turned off. It exposes `identify(userId)` and `reset()`. Its dependencies (fetch, clock,
  storage) are passed in, following the pattern of `SyncService`/`ExtensionSessionDeps`.
- `install-id.ts`: a random install ID kept on the device through the existing storage adapter
  (`packages/core/src/storage/adapter.ts`, chrome and WKWebView adapters). On Apple devices the app and its
  Safari extension share one install ID and account ID through the App Group
  (`packages/ext-safari/lib/native-settings.ts` / the app-group bridge), so Safari use shows up under the same person.
- `consent.ts`: stores the on/off setting on each device (not synced). On by default on Chrome and Apple.
  On Firefox it follows the optional data-collection permission.

**Recognising the same person (first-time vs returning), without fingerprinting:**
- **Same Apple ID (iPhone ↔ Mac, and reinstalls):** keep a Still ID in iCloud key-value storage
  (`NSUbiquitousKeyValueStore`; needs the iCloud key-value capability on both Apple targets). A Mac
  install for someone who already has Still on their iPhone reports `returning: true` under the same person,
  even without signing in.
- **Same Google or Firefox account (a second computer, or a reinstall):** keep the Still ID in
  `storage.sync`, which follows the browser's own sync. During the build, check whether it survives an
  uninstall and reinstall on each browser.
- **Across ecosystems (Apple ↔ Chrome/Firefox):** this can only be known through sign-in. On sign-in,
  `identify(supabaseUserId)` merges every install into one person. Apple forbids fingerprinting (for
  example, matching IP address or device traits), so it's not used.
- Person properties: `first_surface`/`first_store`/`first_seen` (set once), `surfaces` (list), `signed_in`,
  `account_created_at`, and `last_version_<surface>`.

**Dashboard:** build a "Still growth" PostHog dashboard with these charts: daily installs by store,
new vs returning, the activation funnel, the sign-in funnel, daily and weekly active users by store, and
week-1/week-4 retention split by first store. Create it through the PostHog API (key with dashboard-write
access) so it's ready on day one.

**The email reaches PostHog from our server, never from the apps.** A new Supabase Edge Function
`analytics-identify` runs from a database webhook when a new account is created (`auth.users`) and sets
`email` on that user's PostHog person. So no app or extension ever sends an email to PostHog, and
Firefox's permissions don't change. A one-time backfill copies emails for existing accounts.

**Deleting an account also deletes the analytics data.** Extend the existing delete-account Edge Function
(`supabase/functions/_shared/supabase-store.ts` path) to delete the PostHog person through the PostHog API
using a server-only key (`POSTHOG_PERSONAL_API_KEY`). Apple requires that deleting an account deletes its data.

## Where it hooks in

- **Shared UI**, `packages/core/src/ui/controller.svelte.ts` (`UiController`): service toggles, pauses,
  setup, and sign-in start/complete. Because every surface uses this, instrumenting it once covers everything.
- **Chrome/Firefox**, `packages/ext-chromium/entrypoints/background.ts`: `runtime.onInstalled` (install/update),
  the daily `active` event, and building the client. `createSessionSpine` / `createExtensionSession`
  (`packages/core/src/sync/extension-session.ts`) call identify on `verifyCode` success and reset on
  signOut/deleteAccount. Popup and options send `opened`.
- **Apple app**, `packages/app-webview/src/main.ts` with `createAppleSession`
  (`packages/core/src/sync/apple-session.ts`): identify in `enterSession`/`onCodeVerified`, reset in
  `signOutEverywhere`/`deleteAccountEverywhere`. Figure out whether it's iPhone or Mac and the app version
  through the existing native bridge (`packages/core/src/native/bridge.ts`), adding a small `appInfo`
  message on the Swift side if needed.
- **Safari extension**, `packages/ext-safari/entrypoints/{background,popup}`: popup-opened and toggle events,
  using the shared install and account IDs from the App Group.
- **Settings screen:** a "Share usage data" switch plus a one-line notice during setup (text in
  `packages/core/src/ui/strings.ts`). On Firefox the switch triggers the optional data-collection prompt.
- **Build setting:** a new public value `VITE_POSTHOG_KEY` (PostHog's project key is safe to publish,
  since it can only send data). If it's blank, analytics is off, the same way a blank Supabase setting
  turns sync off. Add it to `.env.example` and `docs/CONNECTIONS.md`.
- **Never** import analytics from `packages/core/src/content/**` or the extensions' `entrypoints/content/**`.
  A test enforces this. Content scripts send no analytics at all.
- **Apple iCloud key-value capability** on the iOS and macOS app targets
  (`apps/apple/Still/Still.xcodeproj`), used only to store the Still ID. It's exposed to the web view
  through the native bridge.

## Privacy, policy and store updates (same release)

- **Firefox manifest** (`packages/ext-chromium/wxt.config.ts`): add
  `data_collection_permissions.optional: ["technicalAndInteraction"]` and ask for it at runtime. During
  build, confirm which Firefox version first supports that runtime prompt, and send nothing until permission is given.
- **Apple privacy manifests**: `apps/apple/Still/Shared (App)/PrivacyInfo.xcprivacy` and
  `Shared (Extension)/PrivacyInfo.xcprivacy`. Declare Product Interaction, User ID and Device ID as collected data
  (linked to the user, used for analytics, not tracking).
- **Apple privacy label in App Store Connect** (the owner does this in the portal): Usage Data → Product Interaction;
  Identifiers → User ID and Device ID; Contact Info → Email Address gets "Analytics" added as a purpose. All
  linked to the user, **not** used for tracking. No Browsing History: nothing about visited sites is
  collected.
- **Chrome Web Store privacy tab** (the owner does this in the portal): add User activity, and certify limited use.
- **Privacy policy** `docs/privacy.html`: a new section on usage data covering what's collected, PostHog as
  the processor, the link to the account email, how long data is kept, the off switch, and deletion.
- **Wording that has to change:** the homepage line "no behavioral tracking" (`docs/index.html:151`), and a sweep
  (`rg -i "tracking|analytics"`) through `docs/*.html`, `docs/release/store-listing-copy.md`,
  `docs/release/marketing-playbook.md` and `docs/PRODUCT.md`. Update the "Private by construction" principle
  (and line 145) in `STRATEGY.md` to record the owner's decision, and add a new ADR in `docs/adr/`
  explaining the analytics decision and its boundaries.
- **Website** (`stillapp.fit`, published through the existing gh-pages process): add PostHog web analytics to
  see how visitors arrive and which store buttons they click. Tag store links:
  Chrome/Firefox `?utm_source=stillapp.fit&utm_medium=website&utm_campaign=<page>`; Apple
  `?pt=<provider token>&ct=<page>`. The provider token comes from App Analytics → Campaigns; it needs an
  Admin login, so the owner gets it.

## Human setup (the owner)

1. Create a PostHog US Cloud account and project, then share the project key (public) and a personal API
   key limited to deleting people (secret; goes into Supabase function secrets, never into chat or git).
2. Share the Apple vendor number (for Step 0) and, later, the App Analytics campaign provider token.
3. After the build: update the App Store privacy label, the Chrome privacy tab, and the AMO listing
   description, then submit 2.1.0 to all four stores.

## Delivery

Follow the project's standard process: a plan doc at `docs/plans/2026-09-23-001-feat-usage-analytics-plan.md`,
then the work, a PR, code review, fixes, merge, and a store release. Use one commit per unit: (1) core
analytics module and tests, (2) Chrome/Firefox wiring and Firefox consent, (3) Apple app and Safari
extension wiring and privacy manifests, (4) the identify and delete-account functions plus backfill, (5)
privacy policy, website, STRATEGY, ADR and store copy. Estimated size: about 1–1.5 weeks of build and
testing, plus store review time.

## Verification

- Unit tests (vitest, `packages/core`): the event list rejects details that aren't on the allowed list and
  any web-address-like value; the client batches, retries offline, drops nothing, and sends nothing when off
  or when the key is blank; identify/reset ordering covers the sign-in → sign-out → other-account case;
  an import test makes sure content scripts never reach `analytics/`.
- Extension tests: the Firefox manifest test (`packages/ext-chromium/lib/__tests__/firefox-manifest.test.ts`)
  checks the optional permission; a test confirms nothing is sent on Firefox until permission is given.
- Edge functions: Deno tests for `analytics-identify` and for the delete-account PostHog deletion, including
  PostHog being down (account deletion must still succeed and must not report failure silently).
- Repository checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm exec playwright test --project=fixtures`, plus the StillKit/Xcode builds.
- Returning-user checks: install on iPhone, then on a Mac with the same Apple ID → `returning: true`,
  one person. Install Chrome on a second profile with the same Google sync → `returning: true`.
  Do a fresh install → `returning: false`. Sign-in funnel: abandon once, fail a code once, create a
  new account, and sign into an existing one; each should produce the right events in order.
- Check PostHog against the stores: compare a week of PostHog `installed` totals by store with Apple's
  sales units and the Chrome/Firefox dashboards, and write down the expected gap (downloads that were
  never opened).
- End to end: on each surface (Chrome, Firefox, iPhone app plus Safari, Mac app plus Safari), watch PostHog's Live
  Events for install, toggle and sign-in. Sign into one account on two surfaces and confirm a single person
  with both surfaces and the email. Delete that account and confirm the PostHog person is removed. Look at
  the network traffic to confirm no web address or page content is ever sent.
- Privacy consistency: the privacy policy, App Store label, Chrome privacy tab, Firefox manifest and homepage
  wording all describe the same data before submission.

## Progress

- 2026-09-23: The PostHog setup wizard's code changes (posthog-js in every package, client-side email
  identify, session replay) were backed up outside the repository and reverted. The project key stays
  in the ignored per-package `.env` files. The wizard also turned on Session Replay, Error Tracking
  and "Self-driving" signals in the PostHog project; those are project settings, not code.
- 2026-09-23: Unit 1 landed: `packages/core/src/analytics/` (schema, identity, consent, client), the
  `UiController` analytics seam and sign-in funnel events, and `accountCreatedAt` on verified
  outcomes. Apple sales reports returned 403 for the App Manager API key; a Sales/Finance key is needed.
- 2026-09-23: Units 2–5 landed on `feat/usage-analytics` (draft PR #200): Chrome/Firefox wiring and
  Firefox optional consent; shared extension host; server email attach and deletion; Apple app,
  StillKit identity store and Safari extension; privacy policy (including PostHog's AI analysis,
  which the owner keeps on), website wording, ADR 0004 and the PostHog runbook. Verified locally:
  lint, typecheck, all package tests, build, fixture Playwright (51 passed, 2 skipped), Deno (143),
  StillKit `swift test` (139) and unsigned Xcode builds for iOS and macOS. The fixture run caught
  the notice overflowing the 600px popup; it now floats in the compact popup.
- Remaining: code review and fixes; owner PostHog settings and function secrets; on-device iPhone
  and Mac checks; store privacy declarations (including the Browsing History decision); publishing
  the policy and website with the 2.1 submissions; the Sales/Finance App Store Connect key.
- 2026-09-23: Owner decision: the per-service daily `blocking_worked` signal is removed, so the App
  Store label declares no Browsing History and "Still doesn't collect browsing history" stays true.
  Content scripts send nothing; the content-script files match `main` again. Sections above that
  describe `blocking_worked` are superseded by this entry and ADR 0004. The code review's ten
  findings were fixed (commit 4a84cfb); a Codex review prompt was handed to the owner.
- 2026-09-23: Codex review of 4a84cfb (18 findings). #8 and #17 were resolved by removing the
  blocking signal. Fixed the rest: deletion 202 bodies validated (deletion_errors, nothing queued)
  with one retry; consent re-read before every request, a running flush stops when sharing turns
  off, and any "off" discards the queue (Firefox add-on manager, the Apple app's switch); unreadable
  consent and unsaved identity resets fail closed; Safari re-reads the app's switch, record and
  account on every event; the Apple app lets go of an account on a session-less launch or ended
  session; a start that finds the account gone drops its waiting events; the extension queue moves to
  background-private IndexedDB (no storage.session dependency, iOS 15 included); ids, versions and
  account ids are validated at ingress; a discarded $identify is re-sent; late-synced anchors and the
  Safari extension's provisional anchor are merged with $create_alias; setup_completed is the first
  popup open on Chrome/Firefox; any use counts the day; new accounts are counted by the server once
  per account (app metadata marker), not by a client-side time window; location derivation is
  disabled on every event (policy updated, no location declared); the Swift test suite name is
  unique and cleaned up.
- 2026-09-23: Owner decision: Chrome/Firefox `setup_completed` fires at install (immediately after
  `installed`), because blocking works from install; the first popup open is measured by `opened`.
  Safari keeps "the extension's first run". Verified live: a Chrome build's batches were accepted by
  PostHog (200), with the queue kept out of chrome.storage.local.
- 2026-09-23: Owner request: switch flips carry `where` (popup, options, app), and every event carries
  `device` (phone, tablet, desktop). The Safari extension takes platform and device from its native
  handler (compile-time platform, UIKit idiom), so an iPad is never reported as a Mac.
- 2026-09-23: Fable 5.1 dual review (product analytics + engineering) of bedd9c1. Fixed: background-
  start events are day-stamped and sent later (next Still screen or a random 1-6 h `alarms` flush), so
  nothing reveals when a site was visited; installs seen while sharing was off are kept and counted on
  their real day once sharing is on (extensions and the Apple app); fresh installs wait for storage.sync
  (4 s) or iCloud's initial sync (5 s) before deciding `returning`; native consent fails closed;
  `account_created` counts any account created since the 2.1 launch and writes its marker first;
  deletion treats a body without a queued person as a failure; `sharing_turned_off` measures opt-out.
  Documented instead of coded: HogQL definitions for returning persons and first store, sign-in drop-off
  as a funnel, per-surface semantics, weekly health checks (including the stale-device ghost after a
  deletion and web-view marker loss), the live two-device identity test, the `alarms` justification,
  the Firefox listing wording and the AMO allowlist. Product call (B2), owner decision 2026-09-23: keep
  Chrome sending `installed`/`setup_completed` at install, before the one-time notice is seen; the
  Chrome privacy tab and the privacy policy disclose the collection up front.
- 2026-09-23: Final Codex review of 08a43c5 (9 findings, all confirmed and fixed): quiet events round
  first_seen to the day too; turning sharing off persists "off" and discards the queue before any
  network call, then makes one bounded standalone opt-out send; every send waits for the start's
  account check (extensions) or the launch's account resolution (Apple app), and Safari's alarm flush
  re-reads the app's account first; account_created has a per-account fixed uuid and the account's
  creation time as timestamp, so a race is deduplicated by PostHog; a day of use comes only from real
  use (visit nudge, Still screen), never an alarm wake, and the alarm is requested only when events
  wait; Apple installs and updates are kept as separate pending records; pending aliases persist
  (browser record, App Group) and a discarded alias is re-sent; a Still screen retries a deferred or
  failed server email attach; the runbook separates product events, identity operations and server
  events. Owner completed PostHog steps 1-7 (IP discard, replay off, AI training opt-out, test person
  deleted, deletion key, Supabase secrets).
- 2026-09-23: Codex follow-up on 797fa00 (7 findings, all confirmed and fixed): the server email
  attach is separate from identity (it never changes the account), re-checks account generation and
  consent immediately before the request, and shares one in-flight attempt; startup has one bounded
  result, and an unknown or timed-out account check suppresses account-attributed sends (anonymous
  events may still go) instead of counting as success; the opt-out attempt is skipped under an
  unconfirmed account; every request is bounded (30 s) and abandonable, so turning sharing off never
  waits on the network; the Apple app records a launch's events only after the account settles;
  a shared anchor is adopted at most once per install (no alias chains) and delivered aliases are
  never re-sent; the runbook and privacy policy describe identity payloads and the one opt-out
  attempt accurately. Race reproductions live in packages/core/src/analytics/__tests__/races.test.ts.
- 2026-09-23: Codex follow-up on 45ba56e (6 findings, all confirmed). Rather than patch each race,
  attribution was restructured: clients created by the hosts start unconfirmed, and until a host
  confirms the account (onStart known, a page identify, Safari's account re-read, the Apple launch's
  identify or accountAbsent) events are queued without a person and attributed at send time; a
  timeout never confirms, and a later confirmation is never overruled. Also: a last consent and
  cancellation check with nothing awaited before every request; the opt-out attempt and the server
  attach require a confirmed account; the attach is per account, bounded (15 s) and separate from the
  Apple account check; Apple launch evidence is saved before the account check; only a locally made
  anchor is ever aliased (anchor origin in the browser record and App Group), so chains cannot form
  across installs; the runbook lists when one person counts as two. The race tests now pause at the
  exact race boundary, and two were mutation-checked to fail without their protection.
- 2026-09-23: Codex review of a6cf450 (DO NOT MERGE; 3 P0, 2 P1, all confirmed). The race class was
  removed rather than patched. The client now follows four rules (client.ts header): one operation
  at a time (every state change, flush and opt-out runs serialized, including its request); attribution
  is decided once, in storage, by the confirmation, never at send time, so a retried event keeps its
  person and a deleted account's events leave with it; `confirm(account | null)` is one atomic
  operation (install the account, attribute waiting events, mark confirmed, identify, schedule a
  flush), so a late Apple confirmation resumes delivery; nothing is sent before confirmation. Aliasing
  was removed entirely (ids never change once made; `$identify` is the only merge), in TypeScript and
  Swift. Account deletion now forgets the account for analytics first (bounded 5 s), abandoning any
  send still on its way, and re-identifies if the server deletion fails. New reproductions in
  races.test.ts and controller-analytics.test.ts; each protection was mutation-checked (removing it
  fails a test).
- 2026-09-23: Codex review of 6ab3f8c (DO NOT MERGE; 3 P0 on deletion, 1 P2), each reproduced against
  the source before fixing, plus two more found the same way (an owed drop skipped when someone else
  signs in next; an opt-out asked for before the forget). Three root causes, fixed where they live.
  (1) The forget fence was advisory and late: only `reset()` cancelled, and a flush read the
  cancellation epoch at its turn rather than when asked, so a flush queued behind an in-flight one
  ran under the deleted account after the controller's 5 s wait ended. Now `confirm(null, {forget})`
  cancels synchronously the moment it is called (every host path), and a flush or opt-out remembers
  the epoch it was asked under and sends nothing if a cancellation overtook it. (2) The forget was
  not durable: the drop was best-effort and the account cleared regardless, so a queue store that
  refused the write kept the account's events for a later send. Now the account is recorded as
  forgotten in the state store before the drop, the drop is verified (a refused read is never taken
  as empty), and `flush` sends nothing until it is done, in that process or the next. (3) The
  controller's post-deletion guard was asymmetric with its pre-deletion guard (revision checked only
  with a user present), so a deletion that failed after a sign-out re-identified the signed-out
  account; it now re-identifies only for the session that asked, and signing out resets a deletion
  flow. Seeded-queue regression added for the confirmation send guard. Ten mutations, all caught.
- 2026-09-23: Codex verification of 2d8129f (B1-B4 and the coverage gap confirmed fixed; 2 P0 + 1 P2
  remained, both P0s reproduced here). Same two shapes one level down. (1) The opt-out checked its
  epoch, then awaited two more reads with nothing re-checked before its request, so a forget landing
  in between sent `sharing_turned_off` under the deleted account. Now `post()` takes the epoch its
  caller was asked under and refuses at entry, synchronously, as the last check before the network,
  for the flush and the opt-out alike. (2) A state store read that threw was answered with an empty
  state, which hid the owed drop (and let the next writer overwrite the account and the record of
  the debt). `read()` now returns null for "unreadable" and every reader fails closed: nothing sent,
  nothing written, a forget that cannot even name its account blocks the process. The drop's
  verification reread now has its own regression (a queue store that acknowledges without keeping).
  Runbook and ADR wording corrected: "no queued event" rather than "nothing", the opt-out attempt
  described, and the page-to-background window stated as unbounded with the weekly search as remedy.
  Seventeen mutations, all caught.
