# ADR-0004: First-party usage analytics, with no browsing data by construction

Date: 2026-09-23 · Status: accepted (owner decision; ships with Still 2.1)

## Context

Through 2.0 Still collected nothing beyond sign-in email and synced settings, and the strategy said
"Private by construction. Do not add behavioral analytics merely to make a dashboard easier." The
owner then found that nothing answered the questions the adoption goal depends on: how many people
install on each store each day, whether a new install is someone who already has Still elsewhere,
where the sign-in flow loses people, and who keeps using the product. The stores report only
totals, and never where one person came from.

The owner chose per-person analytics, on by default with an off switch, after weighing the
privacy-positioning cost (the homepage promised "no behavioral tracking") against the need.

## Decision

1. **PostHog Cloud (US), through Still's own client, not posthog-js.** posthog-js loads parts of
   itself from PostHog's servers at runtime, which the extension stores refuse, and captures page
   views automatically, which is the wrong default next to YouTube and Instagram. The client in
   `packages/core/src/analytics/` queues a fixed set of events and posts them to `/batch/`.
2. **A closed event schema.** `events.ts` lists every event and every property; values are
   booleans, fixed words or version numbers. There is no free-text field, so no web address, title,
   video id or search can be sent by any caller. Content scripts, which run on the sites people
   visit, send nothing at all and cannot import the module (a test walks their import graph).
3. **Identity without fingerprinting.** An install id per device, and an anonymous person anchor
   shared only through the person's own sync store: iCloud key-value storage for the Apple apps,
   `storage.sync` for the browser extensions. Signing in merges installs into the account. IP
   address and device traits are never used to link people.
4. **The email is attached server-side.** `analytics-identify` (verify_jwt) sets the account's
   email on its PostHog person from the auth record; no client sends an email to PostHog.
   `delete-user` deletes the PostHog person and events with the account.
5. **Consent.** On by default with a one-time notice and a per-device "Share usage data" switch on
   Chrome and the Apple apps (the Safari extension follows the app's switch). Firefox allows usage
   data only as the optional `technicalAndInteraction` permission, so it is off until granted.
   Nothing is queued while off, and turning it off discards what was waiting.
6. **Never for advertising.** No data is shared with advertisers or brokers, so this is not
   "tracking" under Apple's definition and needs no App Tracking Transparency prompt.

## Consequences

- The privacy policy, the Apple privacy manifests and App Store label, the Chrome Web Store privacy
  tab, the Firefox manifest and the homepage all had to change together, and must keep describing
  the same data.
- A daily per-service "blocking worked" signal was built and then removed (owner decision,
  2026-09-23): "this person was on YouTube today" is browsing history under Apple's definition, and
  keeping "Still doesn't collect browsing history" true is worth more than the metric. Selector
  breakage is watched by the server-side selector canary instead. Do not reintroduce any event
  that is sent from a content script or names a site someone visited.
- A person who never signs in and uses Still on both Apple and a browser counts as two people.
- No location: every event carries `$geoip_disable` and the project discards client IPs.
- New accounts are counted by the server once per account, never inferred by a client.
- Consent is re-read before every request and fails closed; anything waiting is discarded when
  sharing turns out to be off, however it was switched off.
- Store totals remain the source of truth for downloads; PostHog counts first opens.

See the plan: [2026-09-23 usage analytics](../plans/2026-09-23-001-feat-usage-analytics-plan.md).
