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
- No visit timing: a background usually starts because a supported site was opened, so events
  recorded at a background start carry only their day and are sent later (the next Still screen, or
  an `alarms` flush at a random time one to six hours out). Their timestamps and their arrival say
  nothing about when a site was visited; that includes every timestamp inside them, such as the
  first-seen person property. The server email attach runs only from an ordinary, non-background
  identify, retried at the next Still screen. A day of use comes only from real use, never from the
  alarm itself, and every send waits for the start's account check.
- Attribution is decided once: until a host confirms who is signed in (or that nobody is), events
  are queued without a person and nothing is sent. The confirmation, a single serialized operation,
  installs the account, gives every waiting event its person in storage, and only then allows sends;
  an event keeps that person through retries and is never re-attributed. A timeout never counts as
  confirmation. Every state change and every send runs one at a time in the client. Ids never change
  once made and are never aliased; `$identify` at sign-in is the only merge.
- Deleting an account forgets it for analytics first, and only then asks the server to delete the
  account and its person. Forgetting fences the account the moment it is asked: the send on its way
  is abandoned and every send asked for before that moment sends nothing at its turn, so the bounded
  wait (5 s) can end without releasing anything under the account: no request starts under a
  cancelled epoch, checked last, after every read. The account is recorded as forgotten before its
  queued events are dropped, and the drop is verified by re-reading the queue; if the queue store
  refuses or does not keep the drop, or the state store cannot be read, no queued event is sent
  until a later confirmation or flush completes the drop, in that process or the next. A deletion
  that fails re-attributes the account only to the session that asked, never after a sign-out.
  Outside the client's reach: a device that is offline, or an extension background that receives
  the popup's request after the wait ended, can still deliver what it had queued under the account;
  the runbook's weekly check is the remedy, not a bound.
- Turning sharing off takes effect before any network call: the waiting queue is discarded, and one
  standalone `sharing_turned_off` attempt (bounded to a few seconds) is the only thing sent.
- New accounts are counted by the server once per account, never inferred by a client.
- Chrome and Firefox send `installed` and `setup_completed` at install, before the one-time notice
  is seen (owner decision, 2026-09-23): counting every install outweighs holding them, and the store
  privacy declarations and the privacy policy disclose the collection up front.
- Consent is re-read before every request and fails closed; anything waiting is discarded when
  sharing turns out to be off, however it was switched off.
- Store totals remain the source of truth for downloads; PostHog counts first opens.

See the plan: [2026-09-23 usage analytics](../plans/2026-09-23-001-feat-usage-analytics-plan.md).
