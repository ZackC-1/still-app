# PostHog usage analytics: setup and operations

Current for Still 2.1. The decision and its boundaries are [ADR 0004](../adr/0004-first-party-usage-analytics.md);
the build plan is [2026-09-23 usage analytics](../plans/2026-09-23-001-feat-usage-analytics-plan.md).
Portal state changes; verify it directly before acting. Never put keys in this file, a commit or chat.

## What sends what

| Surface | Sends | Consent |
|---|---|---|
| Chrome extension background | installs (returning or not) with setup complete at install, updates, active days, popup/options events | On by default; one-time notice; switch in options |
| Firefox extension background | the same | Off until the optional `technicalAndInteraction` permission is granted |
| iPhone / Mac app web view | installs or updates, app opened, Mac extension enabled, opens, switch flips (`where: app`), active days, sign-in funnel | On by default; one-time notice; switch in the app |
| Safari extension (iPhone / Mac) | setup complete, extension enabled, active days, popup events, under the app's install | Follows the app's switch |
| Supabase `analytics-identify` | the signed-in account's email onto its person, and `account_created` once per new account | Called only while sharing is on |
| Supabase `delete-user` | deletes the account's person and events | Always, with the account |

Three kinds of message reach PostHog:

- **Product events** from the apps and extensions (installed, active, opened, toggles, the sign-in
  funnel, sharing_turned_off). Each is checked against `packages/core/src/analytics/events.ts` and
  carries `surface` (chrome, firefox, safari-ios, safari-macos, app-ios, app-macos), `store` (ios,
  macos, chrome, firefox), `device` (phone, tablet, desktop), `app_version` and `signed_in`, so
  Safari on an iPhone, an iPad and a Mac are separate lines in any chart. Switch flips carry
  `where` (popup, options, app).
- **Identity operations** from the apps and extensions. `$identify` links the install to the
  account: it carries Still's install/person ids, the account id, and the same person properties as
  product events (the surface and store in use, the version, the kind of device, and the first-seen
  day or time). It carries nothing else, and it is the only merge Still makes: ids are never
  aliased, and an install's ids never change once made.
- **Server events** from `analytics-identify`: the account's email as a person property, and one
  `account_created` per account, keyed only by the account id.

No page, video, search or free text can be sent, and content scripts (on the sites people visit)
send nothing.

## PostHog project settings (owner)

1. Use the US Cloud project that holds the key in the ignored `packages/*/.env` files.
2. The setup wizard turned on Session Replay, Error Tracking and "Self-driving" (AI) signals. The
   owner keeps Self-driving on (decision 2026-09-23), so the privacy policy discloses that PostHog
   passes usage data to its AI model providers. In the organization's AI settings, opt out of
   PostHog using the data to improve its own AI, which the policy does not permit. Leave Session
   Replay off unless the website adopts it deliberately (see Website below). If the list of AI
   providers in PostHog's subprocessor page changes, update the policy.
3. In project settings, turn on **Discard client IP data**. Every event also carries
   `$geoip_disable`, so no location is derived; the Apple privacy manifests declare no location, and
   the privacy policy says so. Country-level download numbers come from the stores' own reports.
4. Create a personal API key with only the **person: write** scope, for deletion.

## Server (Supabase function secrets)

Set these on the hosted project (`supabase secrets set --env-file <private file>`; never inline):
`POSTHOG_PROJECT_KEY`, `POSTHOG_HOST` (`https://us.i.posthog.com`), `POSTHOG_API_HOST`
(`https://us.posthog.com`), `POSTHOG_PROJECT_ID`, `POSTHOG_PERSONAL_API_KEY`. Then deploy
`analytics-identify` and `delete-user`. Either function skips its PostHog step quietly when its
settings are missing.

**Deletion follow-up.** If PostHog is down during an account deletion, the account is still deleted
and the function logs `ANALYTICS DELETION FAILED for account <uuid>`. Check the `delete-user` logs
weekly while monitoring is manual, and delete any logged person in PostHog (Persons → search the
id → Delete person, with events).

**Existing accounts.** Accounts created before 2.1 get their email attached the next time a 2.1
surface identifies them. A one-time backfill (list auth users, set each email on its person) needs
the owner's explicit go-ahead because it writes every account's email to PostHog at once.

## Builds

Release builds need `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST` in `packages/ext-chromium/.env`,
`packages/ext-safari/.env` and `packages/app-webview/.env`. A blank key ships no analytics and no
switch. Firefox source archives for AMO carry only the explicit allowlist of public values.

## Store declarations (owner, before submitting 2.1)

- **App Store Connect → App Privacy** (both iOS and macOS): add *Usage Data → Product Interaction*
  (Analytics) and *Identifiers → Device ID* (Analytics); add *Analytics* as a purpose on
  *Contact Info → Email Address* and *Identifiers → User ID*. All linked to the user, **not** used
  for tracking. Do **not** declare *Browsing History*: nothing about the sites people visit is
  collected (the per-service "blocking worked" signal was removed for exactly this reason).
- **Chrome Web Store → Privacy practices:** add *User activity* to the collected data, keep the
  existing disclosures, and re-certify the Limited Use statements.
- **Firefox AMO:** the manifest declares the optional permission, and Firefox shows it at install.
  Mention usage data in the listing's privacy section.
- **Chrome Web Store permission justification** for the new `alarms` permission: "Sends
  Still's usage statistics at a random later time, so they never reveal when a supported site was
  visited." It shows no warning to users.
- Confirm **Discard client IP data** is on in PostHog before publishing the privacy policy, which
  states it.
- The privacy policy (`docs/privacy.html`) and homepage wording must be published to
  `stillapp.fit` before or with the store submissions, so every declaration matches.

## Website

Store links on `stillapp.fit` can carry campaign tags so each store's own dashboard shows the
website's share: `?utm_source=stillapp.fit&utm_medium=website&utm_campaign=<page>` for the Chrome
Web Store and AMO, and `?pt=<provider token>&ct=<page>` for the App Store (the provider token is in
App Store Connect → App Analytics → Campaigns and needs an Admin login). PostHog on the website is
optional; if added, use cookieless mode so no cookie banner is needed, and add it to the privacy
policy's website section first.

## Reading the data correctly

These definitions are the ones to build on. Several events mean slightly different things on
different surfaces, so label every insight with the definition it uses.

- **Installs.** `installed`, broken down by `store`. PostHog counts the first run with sharing on
  (an install with sharing off is counted later, on its real day, once sharing is turned on), so
  expect it to sit below the stores' own download numbers by a steady gap. Compare weekly.
- **Returning person.** Do not rely on the `returning` flag alone; iCloud and browser sync can
  arrive after an install decides. Use a HogQL insight: an `installed` is returning when the same
  person already has an earlier event from a different `$device_id`.
- **First store.** The `first_store` person property is set by whichever device signed in first.
  For "where did this person first install", use the `store` of the person's earliest `installed`
  (HogQL `argMin(properties.store, timestamp)` over `installed`).
- **Setup.** `setup_completed` is at install on Chrome and Firefox (they block from install), and
  the Safari extension's first run on iPhone, iPad and Mac. The Mac app also reports
  `setup_step {step: extension_enabled}`.
- **Active.** One `active` per install per local day, from real use only: opening a Still screen, a
  switch flip, or the content script's nudge when a supported site is opened. A background start by
  itself (a browser restart, the analytics alarm) records nothing. Events recorded from a nudge or a
  background start carry only their day (local midnight) and are sent later, so never read
  hour-of-day from them. Use weekly active persons as the headline; daily as a
  trend.
- **Opens.** `opened {where: popup|options}` is an extension screen; `opened {where: app}` is a launch
  of the iPhone/Mac app, which most people rarely reopen once set up.
- **Sign-in drop-off.** Measure it as a funnel, `sign_in_opened → code_requested → signed_in` within
  24 hours, unique persons. `sign_in_abandoned` only fires when someone presses the sheet's close
  button; a popup that closes because focus moved fires nothing, so it undercounts.
- **New accounts.** `account_created` is sent by the server once per account created since the 2.1
  launch, when the account first shares usage. Break it down by the person's first store. It counts
  only people who share usage.
- **Opt-out rate.** `sharing_turned_off` is sent once when someone turns sharing off with Still's own
  switch (not when Firefox's permission is withdrawn in the add-on manager). Read Firefox separately:
  it is an opt-in sample.
- **When one person counts as two.** Persons are an estimate. Expect some people to appear twice:
  someone who uses Still on Apple and in a browser without ever signing in; someone who signs out on
  a device and keeps using it (a fresh anonymous id, on purpose); a device whose first sync arrived
  after it had already made its own id (ids never change once made, so only a sign-in joins the two);
  and a device that stayed offline through an account deletion. Two people share one person when they share
  a Chrome profile or an Apple ID. Use distinct `$device_id` for install counts and persons for
  people, and treat the gap as the uncertainty.
- **Events before the account is confirmed.** While an extension or the Apple app is still
  confirming who is signed in, new events are held without a person, and nothing is sent. The
  confirmation gives them their person, once, in storage, and sends them. An event keeps that person
  through failed sends until it is delivered or its account is deleted; it is never re-attributed. If
  confirmation never comes (a lookup that keeps failing), those events wait; they are never sent under
  a guessed account.
- **Installs vs persons.** Shared Chrome profiles and shared Apple IDs merge people; signing out gives
  a device a fresh anonymous id. Chart distinct `$device_id` alongside persons.

## Weekly health checks

- `installed` by store against App Store Connect units and the Chrome/AMO dashboards.
- Persons whose distinct id is an account UUID but have no email (a stuck identify).
- The `code_failed` reason mix: a jump in `network` means the backend.
- The `delete-user` logs for `ANALYTICS DELETION FAILED`, and, a week after any account deletion,
  a Persons search for the deleted account id: a device that was offline during the deletion can
  send a few events under it before it learns the session ended. Delete any such person.
- PostHog's ingestion warnings: "cannot merge already identified" means an identify was refused.
- Known small inaccuracy: the Apple app keeps its once-a-day and once-ever markers in the web view's
  storage, which iOS can clear under storage pressure; that can repeat an `app_opened` step or an
  `active` for a day.

## Before relying on identity numbers

Run the plan's returning-user checks against the live project with two real devices (iPhone and Mac
on one Apple ID; two computers on one Google account; then sign in on both) and record the results
in the plan: which person survives, whether its email and first store are right, and whether any
ingestion warning appeared.

## The "Still growth" dashboard

Build these insights (all filterable by `store` and by the person property `first_store`):
daily `installed` by `store`; `installed` split by `returning`; the activation funnel
`installed → setup_completed → active` (plus `setup_step` by `step`); the sign-in funnel
`sign_in_opened → code_requested → signed_in` with `code_failed` by `reason` and
`sign_in_abandoned` by `stage`, plus new accounts from `account_created` (sent by the server once per
account); daily and weekly active persons from `active` by `store`; and
retention from `installed` to `active` at week 1 and week 4, split by `first_store`.

## Money questions

RevenueCat never holds money. App Store purchases are paid by Apple (App Store Connect → Payments
and Financial Reports). Web purchases, if any were ever live, would be in the connected Stripe
account. The App Manager API key cannot read sales or finance reports; reading them through the API
needs a key with the Sales and Finance roles.
