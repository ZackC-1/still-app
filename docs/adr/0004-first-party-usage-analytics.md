# ADR-0004: First-party usage analytics, with no browsing data by construction

Date: 2026-09-23 · Status: accepted (owner decision; ships with Still 2.1). Consent reaffirmed for V3
by the owner on 2026-10-10; see [V3 consent](#v3-consent-2026-10-10).

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
   data only as the optional `technicalAndInteraction` permission, which Firefox offers in its own
   install prompt: sharing is on exactly while that permission is granted. Nothing is queued while
   off, and turning it off discards what was waiting. V3 builds implement this through a per-device
   permission record ([V3 consent](#v3-consent-2026-10-10)).
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
  failed installation or attribution stays pending and is retried before sending. A newer account
  answer cannot erase an unfinished forget. An event keeps its person through retries and is never
  re-attributed. A timeout never counts as confirmation. Every state change and every send runs one at a time in the client. Ids never change
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
  the runbook's weekly check is the remedy, not a bound. An unfinished forget is held by the running
  client until storage accepts its durable record. If the process ends before either store accepts
  that record, the next process cannot know the account was deleted: it drops the account's queued
  events only if it learns that nobody is signed in; if a different account is established first,
  those events can still be sent under the deleted account. Permanent storage loss is outside this
  guarantee.
- Turning sharing off takes effect before any network call: the waiting queue is discarded. In 2.1,
  one standalone `sharing_turned_off` attempt (bounded to a few seconds) was the only thing sent; V3
  sends nothing at all when sharing is turned off (the closed schema has no such event), and records
  `analytics_choice_made {choice: "share"}` when it is turned back on.
- New accounts are counted by the server once per account, never inferred by a client.
- Chrome and Firefox send `installed` and `setup_completed` at install, before the one-time notice
  is seen (owner decision, 2026-09-23): counting every install outweighs holding them, and the store
  privacy declarations and the privacy policy disclose the collection up front.
- Consent is re-read before every request and fails closed; anything waiting is discarded when
  sharing turns out to be off, however it was switched off.
- Store totals remain the source of truth for downloads; PostHog counts first opens.

## V3 consent (2026-10-10)

Owner decision, 2026-10-10: "By default I want people's analytics turned on. They can turn them off."
This reaffirms decision 5 for V3 and replaces the V3 plan's per-device fresh opt-in (R8) for usage
sharing. The privacy limits above are unchanged: the closed event schema, nothing from content
scripts, no pages, videos or searches, no fingerprinting, never advertising.

V3 builds (`VITE_MODERN_SETTINGS_SYNC_ENABLED=true` in the browsers; the D04 screens in the Apple
app) behave as follows. `packages/core/src/analytics/default-on.ts` is the authority.

- **Permission record.** Every send needs a granted per-device permission record whose version is
  the SHA-256 of the default-on disclosure (`USAGE_DISCLOSURE`). Each record has its own private
  origin, from which the provider ids are derived. The host passes `DEFAULT_ON_USAGE_POLICY`, which
  claims no erasure or retention capability evidence: this decision promises none (switching off
  stops collection and discards what waits; deleting the account deletes what was sent). The
  capability-evidence gate remains for any other policy.
- **Chrome.** The first read with no recorded choice grants the permission, so `installed` and
  `setup_completed` are reported from install. The one-time notice ("Still shares usage data to
  help improve the app. It never includes the sites or videos you visit.", Turn off / OK) and the
  "Share usage data" row on the first-run and settings pages ("Helps improve Still. Never includes
  the sites or videos you visit.") show it on and are the off path. The notice is versioned by the
  disclosure: a device that acknowledged an earlier notice (including the 2.1 notice) sees it again
  when the disclosure changes, with sharing still on. Off stores a stopped record;
  no later read grants again. The switch turns it back on under a new origin, so new ids: the
  device then counts as a new anonymous person.
- **Firefox.** Sharing follows the optional `technicalAndInteraction` data-collection permission.
  Granted in Firefox's install prompt means on from install. The settings switch requests the
  permission inside the tap (declined: stays off) or withdraws it. If Firefox refuses or fails to
  withdraw it, Still's own off is kept by a durable "stopped by Still" mark until the switch turns
  sharing back on (or Firefox reports the permission withdrawn); when Firefox does withdraw it, no
  mark remains, so a later grant in the add-on manager turns sharing on. Withdrawing it in the add-on
  manager ends the permission at the next read and discards what waits. There is no notice.
- **Apple apps.** The app grants the permission in the App Group at its first launch with no
  recorded choice, and shows the existing one-time notice (versioned as above) and switch on the
  settings screen. While sharing is off the switch stays visible, showing off; when the state cannot
  be read the switch is hidden. An off that the App Group does not take is reported as a failure, so
  the switch keeps showing on rather than claiming an off the Safari extension would not follow.
- **Safari extension.** Reads the app's record through the native handler's read-only
  `analyticsPermission` lane and never grants, stops or writes one. Before the app has created the
  record it reports nothing. When the app turns sharing off it stops sending at once; events that
  were waiting in the extension are never sent and are discarded when sharing is next allowed.
- **Upgrades from 2.1.** The 2.1 "on" value (or no value) counts as no choice, so sharing is on,
  and the notice is shown again because the disclosure changed; a 2.1 "off" stays off. The
  permission's ids are new, so the device's 2.1 person and its V3 person are different people in
  PostHog (a person split at upgrade).
- **Turning sharing off** fences work in flight, discards the queue and sends nothing.
- **Signed-in devices (owner decision 50, 2026-10-10: finish it).** A signed-in device reports under
  its own identity: from an ordinary Still screen (never a background start) it sends
  `analytics-identify` only the origin proof (a one-way hash of its private permission origin) and
  `projectKeySha256` (the SHA-256 of the public PostHog project key it sends events with), with that
  account's own session. The server issues identities only to builds that report to its own project:
  any other build is answered `test_channel`, which the client treats like unavailable (it keeps
  waiting and never stops sharing). The server issues or returns the device's random subject (never the
  account id) and attaches the account's email to it on the server. The client never sends the
  account id or the email to PostHog. Deleting the account records every subject of the account for deletion
  (`delete-user`, migrations 0017/0018), and the scheduled `analytics-erasure` worker deletes those
  persons and their events from PostHog; the worker must be scheduled before the switch is turned on.
  The Apple app publishes its subject to the App Group once the client has confirmed it (republished
  when the App Group no longer holds it; withdrawn when the app signs out, sharing is turned off or
  the server stops the identity). The Safari extension reads it, a local read with no network, at
  every background start as well as from its pages, only for the same account and permission; it
  drops a cached identity the App Group no longer confirms, and never calls the server. After a 503,
  a 429 or a `test_channel` answer a client waits 15 minutes before asking again.
  Until the server's `ANALYTICS_SUBJECTS_ENABLED` switch is on, the server answers 503 and a signed-in
  device's events wait on the device, bound to the account (dropped if it signs out, sent once it has
  its identity, never older than 30 days). Signed-out use is reported under the device's anonymous
  id.

Builds without these flags (every 2.x store package) are byte-for-byte unchanged by this section.
In current source those 2.x hosts supply no permission record, so a 2.x package rebuilt from this
code would report nothing; the shipped 2.1.x packages predate that change and follow decision 5 as
first built.

See the plan: [2026-09-23 usage analytics](../plans/2026-09-23-001-feat-usage-analytics-plan.md).
