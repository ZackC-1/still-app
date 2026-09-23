# PostHog usage analytics: setup and operations

Current for Still 2.1. The decision and its boundaries are [ADR 0004](../adr/0004-first-party-usage-analytics.md);
the build plan is [2026-09-23 usage analytics](../plans/2026-09-23-001-feat-usage-analytics-plan.md).
Portal state changes; verify it directly before acting. Never put keys in this file, a commit or chat.

## What sends what

| Surface | Sends | Consent |
|---|---|---|
| Chrome extension background | installs (returning or not), updates, setup, active days, popup/options events | On by default; one-time notice; switch in options |
| Firefox extension background | the same | Off until the optional `technicalAndInteraction` permission is granted |
| iPhone / Mac app web view | installs or updates, app opened, Mac extension enabled, opens, active days, sign-in funnel | On by default; one-time notice; switch in the app |
| Safari extension (iPhone / Mac) | setup complete, extension enabled, active days, popup events, under the app's install | Follows the app's switch |
| Supabase `analytics-identify` | the signed-in account's email onto its person, and `account_created` once per new account | Called only while sharing is on |
| Supabase `delete-user` | deletes the account's person and events | Always, with the account |

Every event is checked against `packages/core/src/analytics/events.ts`. No page, video, search or
free text can be sent, and content scripts (on the sites people visit) send nothing.

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
- The privacy policy (`docs/privacy.html`) and homepage wording must be published to
  `stillapp.fit` before or with the store submissions, so every declaration matches.

## Website

Store links on `stillapp.fit` can carry campaign tags so each store's own dashboard shows the
website's share: `?utm_source=stillapp.fit&utm_medium=website&utm_campaign=<page>` for the Chrome
Web Store and AMO, and `?pt=<provider token>&ct=<page>` for the App Store (the provider token is in
App Store Connect → App Analytics → Campaigns and needs an Admin login). PostHog on the website is
optional; if added, use cookieless mode so no cookie banner is needed, and add it to the privacy
policy's website section first.

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
