---
title: "Safari popup setting changes sync on their own, without opening the Still app (ISS-0063)"
status: draft (design only; doc-reviewed round 1; awaiting root approval before any product code)
date: 2026-10-15
owner: "Claude Code (packet 4 lane)"
branch: "feat/iss0063-safari-extension-sync-20261015"
---

# Safari popup setting changes sync on their own (ISS-0063)

## Outcome

A signed-in person changes a switch in the Still popup in Safari on iPhone (or iPad, or Mac) while
the Still app on that device is closed. Within a few seconds the change reaches every other
signed-in surface that is listening live today: Chrome, Firefox desktop, and any Still app that is
running (Mac app, iPhone app), including Safari on a Mac whose Still app is running. This matches
an edit made in Chrome today (XD-01 about 1 s, XD-03 about 2 s). Safari on another device whose
Still app is closed picks the change up when its popup or its app is next opened (the inbound rule
below). An edit made offline is sent the next time the popup is used online.

Nothing changes for people who are not signed in. Host permissions stay exactly the four services,
no new browser permission is added, and nothing from the sites people visit is ever sent.

Owner decision (15 Oct): plan 1, "sync on their own", for changes made in the iPhone Safari popup.
The interim "open the app to sync" copy was not chosen. How changes made elsewhere reach Safari
while its app is closed is decision D1 below.

## The problem today (evidence)

All claims below were read from `origin/main` at `3f230c80` (the source of QA package .361). None
of the design has been runtime-verified yet; Unit 0 is the device spike that does that.

1. **The extension never talks to the account.** `SafariWebExtensionHandler.swift` routes popup
   messages only to App Group lanes (`SettingsBridge`, `EntitlementBridge`, `AccountSyncStatusStore`,
   analytics ids). `SettingsBridge.safariExtension` sets `admitsAtomicCommands: false`, and its doc
   comment records the current rule: the app is "the only cloud client and the only converter
   (U3-W4 design, authority split)". `ExtensionBridgeAuthorityTests.swift` (T9) pins that refusal.
2. **The popup's edit is already saved durably as a pending entry.** A Safari popup toggle is a
   `settingsIntent` sent straight from the popup page to native (`ChromeStorageAdapter.commitIntent`,
   Safari branch); the handler commits it through `SharedSettingsStore.commitIntent`. On a signed-in
   record that appends a pending entry (write id, the record's account scope, the server receipt it
   was based on, and per-field operations) inside the App Group record (`AtomicSettingsWriter.commit`
   / `AtomicSettingsRecord.commit`). The edit is not lost; it waits for someone to send it.
3. **Only the app's web view sends it.** The containing app's WKWebView runs core's `SyncService`
   (`packages/app-webview/src/main.ts`), whose `flushAtomic` takes the first sendable pending entry,
   posts it to `sync-settings` and writes the server's answer back with the native `acknowledge`
   command. iOS does not run that web view in the background, so nothing sends the entry until the
   person opens the app, which matches the owner's report exactly.
4. **The account session lives only inside the app's web view.** `main.ts` creates the Supabase
   client with `storage: safeStorage()`, the web view's `localStorage` (file origin). No other process
   on the device can read it today, and no session is in the Keychain or App Group.
5. **Uploads must run under the same session that owns the record.** `SyncService.ownsAtomicSession`
   refuses to send unless the current auth session's `session_id` claim equals the record scope's
   `sessionId`; a different session for the same account forces a scope change, which retires the
   pending entries (`enterScope` with ownership other than `never-linked` empties `pending` and pauses
   with `ownership-unconfirmed`). A separate sign-in for the extension would discard exactly the
   edits we need to send. The extension has to use the app's session.
6. **Safari on the Mac has the same gap (code read, not runtime-verified).** The same extension and
   handler ship on the Mac, and `applicationShouldTerminateAfterLastWindowClosed` returns true, so
   with the Mac app's window closed nothing sends Safari Mac popup edits or brings changes in. QA saw
   Safari Mac receive changes on .361 (ISS-0058) most likely because the Mac app was running.
7. **Inbound changes while the app is closed.** The App Group record is only updated from the
   account by the app's `SyncService`. With the app closed, the Safari popup and Safari's blocking
   keep the last record the app wrote, until the app opens. Safari content scripts block from the
   `browser.storage.local` projection, which the background reconciler refreshes from the App Group
   on a reconcile message.
8. **No background-task policy test was found.** The lead mentioned a StillKit test forbidding
   BGTask/timers; no such test exists on `origin/main` (no `BGTaskScheduler`, `BackgroundTasks` or
   `UIBackgroundModes` anywhere). It does not matter: iOS background refresh runs at the system's
   discretion (minutes to hours), so it cannot meet "within seconds".
9. **Precedent for network calls from the Safari extension without host permissions.** The Safari
   background already fetches the signed rule set from the Supabase URL (`createRuleSetRefresher`)
   and sends analytics batches (`createExtensionAnalyticsHost` uses `fetch`); neither host is in
   `host_permissions`. Every Supabase function answers with `access-control-allow-origin: *`
   (`supabase/functions/_shared/store.ts`, pinned by `auth.test.ts`), and Chrome and Firefox already
   run the same `SyncService` from their backgrounds with the same four host permissions. This shows
   the CORS pattern; the **authenticated** preflight (Authorization header) from Safari is proven only
   by Unit 0(a).
10. **Retries are already idempotent server-side.** `sync-settings` claims each write id with its body
    (`private.claim_settings_write`), and the client rebuilds a retry from the stored entry byte for
    byte (`pendingSettingsRequest`). Two senders on one device sending the same entry is safe.
11. **Platform facts that shape the design.** supabase-js 2.116's `lock` option is a deprecated
    legacy path (the default is lockless, with an in-process storage commit guard that cannot see
    another process), so it cannot be the basis of cross-process refresh safety. The Mac extension
    target is sandboxed (`ENABLE_APP_SANDBOX = YES`) without `ENABLE_OUTGOING_NETWORK_CONNECTIONS`,
    so native networking from the Mac extension process needs that entitlement; the iPhone extension
    needs none.

## Recommended design (plain English)

Let the Safari extension send its own pending edits, using the sign-in the app already has, while
the long-lived part of that sign-in never leaves native code.

1. **One shared sign-in, kept in the Keychain.** The app keeps its account session in a Keychain
   item that only Still's app and Still's Safari extension can read, instead of in the web view's
   storage. This is also safer than today, where the session sits in an unencrypted web-storage file.
2. **Only native code renews the sign-in.** Sign-in tokens expire hourly and are renewed with a
   one-time-use renewal token. Native code (StillKit) is the only thing on the device that renews,
   one process at a time (a short claim recorded in the App Group), and it saves the new tokens only
   if nothing changed meanwhile, such as a sign-out. Neither web view nor extension script can renew by itself (their renewal
   requests are blocked). The extension's script only ever receives the short-lived access token.
3. **The extension's background sends pending edits.** When the popup commits a change, it asks the
   Safari background to sync. The background runs the same `SyncService` code Chrome and Firefox use,
   over the same App Group record the app uses: it sends the pending entry to `sync-settings` and
   writes the answer back through the existing native `acknowledge` step, which already does the
   per-field merge. No new merge code, no second sync engine.
4. **The app keeps every account decision.** Signing in, signing out, switching accounts, deleting
   the account and starting the first sync remain app-only. The extension may only: (a) send entries
   already pending under the app's current account and session; (b) save the server's answer for
   that same account and session; (c) ask native for the current access token (native renews it if
   needed); (d) update the popup's sync status fields (last synced time, pending, reachable) for the
   account the app recorded. It never writes or removes the session and never changes account id or
   email. If anything does not match (signed out, a different account, a newer session), the
   extension does nothing and leaves the edit for the app.
5. **Changes from other devices come in when the popup opens.** Opening the Safari popup (or the
   extension's settings page) reads the account once, saves the result, and refreshes what Safari's
   open tabs block by. We deliberately do **not** contact the server when a supported site loads: a
   request timed to page loads would tell our server when someone opened YouTube or Instagram. See D1
   for the honest cost and an optional middle setting.
6. **Offline edits retry quietly.** The pending entry stays in the App Group until it is accepted. It
   is retried on the next popup open, on the next popup edit, when the app opens, when the browser
   reports it is back online while the background is awake, and on a randomly delayed quiet alarm
   scheduled from those same events (the existing `alarms` permission), never from a page load.

No new host permission, no `<all_urls>`, no new browser permission, no new analytics event, no
background mode. One possible signing change on the Mac (D3).

## Options considered

| Option | Verdict | Why |
|---|---|---|
| A. Extension background runs core `SyncService`; native holds the session and is the only renewer; extension JS gets only the access token | **Recommended** | Reuses the shipped sync engine, fencing, retry and per-field merge in full. The renewal token never reaches extension JavaScript. One renewer per device removes the cross-process rotation race. |
| A-alt. As A, but the extension JS also holds the renewal token, coordinated by a JS-side lease | Rejected after review | The renewal token would be readable by any extension context (native cannot tell the background from content scripts), the lease cannot fence a suspended holder, and the supabase-js lock it relies on is deprecated. |
| B. Native handler (Swift) also sends the settings requests (JS never sees any token) | Fallback | Strongest isolation, but native becomes a settings transport with its own request/response handling, and the access token in JS is a bounded (one hour) exposure. Switch to this if Unit 0(d) shows content scripts can call native messaging and review then rejects the residual. |
| C. Separate sign-in for the extension | Rejected | A different `session_id` forces a scope change that retires the pending entries (evidence 5), and asks people to sign in twice. |
| D. iOS background refresh in the app (BGAppRefreshTask) | Rejected | Runs when iOS decides (often hours); cannot meet "within seconds". |
| E. New host permission for the Supabase host | Rejected | Not needed (evidence 9); would change Safari's permission prompt and need product/privacy review. |
| F. Pull on every supported page load | Rejected (D1) | Fast inbound updates, but reveals site-visit timing to the server. |
| G. A new server-issued, device-scoped settings-write credential stored in the App Group | Rejected for this packet | Needs a new credential type, issuing function and `sync-settings` auth path; it would not carry the `session_id` the record's scope fencing depends on, so the fencing would need server changes too. Still a bearer secret on the device. Higher cost than A for the same exposure. |

## Detailed design

### D-1. Shared session store and the single native renewer (StillKit + both hosts)

- New StillKit module `SharedAuthSession.swift`. It stores exactly one value, the supabase-js session
  for the build's project ref (`sb-<ref>-auth-token`), as one generic-password Keychain item with
  `kSecAttrAccessGroup = group.com.chartash.still` (the existing App Group),
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (never synced to iCloud Keychain, never restored
  to another device), and `kSecUseDataProtectionKeychain` on macOS. Using the App Group as the
  Keychain access group is expected to work on iOS and macOS but depends on Unit 0(b); if it fails,
  stop and take D3. QA and production builds use different project refs, so sessions never collide.
- Values are capped at 16 KiB and are never logged.
- **Single renewer, never holding a file lock across the network.** iOS kills a process that is
  suspended while holding a file lock in a shared container (termination `0xdead10cc`), so no lock is
  held during the renewal request. Every read goes through `SharedAuthSession.current()`, which runs on
  a dedicated serial queue (never the main actor; replies are asynchronous):
  1. Under a short `flock` transaction on a dedicated App Group file (microseconds, same mechanism as
     `AtomicSettingsBacking`): read the session; if the access token is valid for more than 5 minutes,
     return it. Otherwise, if no live renewal claim exists, write a claim `{holder, generation+1,
     expiresAt: now+25 s}` and remember the renewal token `T` it was taken for. If another process holds
     a live claim, release the lock and poll (up to 3 s) for its result; on timeout return the stored
     session unchanged.
  2. Without any lock, and inside a suspension guard (`beginBackgroundTask` in the app,
     `ProcessInfo.performExpiringActivity` in the extension), send one
     `POST /auth/v1/token?grant_type=refresh_token` with a 10 s timeout.
  3. Under a short `flock` transaction: save only if the stored renewal token is still `T`, the claim
     generation is still ours, and the new access token's `sub` and `session_id` equal the stored ones
     (compare-and-swap); then clear the claim. Native writes the session JSON in the shape supabase-js
     validates (`access_token`, `refresh_token`, `expires_at`, `expires_in`, `token_type`, `user`),
     preserving any other stored members.
  The auth lock and the settings lock are never held at the same time. A process that dies mid-request
  leaves a claim that expires in 25 s; the remaining crash window (server rotated, save not reached) is
  bounded by the suspension guard and by how hosted Auth treats a renewal token whose child was never
  used (Unit 0). The Supabase URL, anon key and route profile are compiled into native (Info.plist
  values from build settings, checked by the existing release env guard alongside the web builds),
  never taken from a message.
- **Renewal outcomes.** Network failure, timeout, 5xx or any non-authoritative error (including 401
  for a bad API key): return the stored session unchanged; `authAccess` then replies
  `{status:"unavailable"}` if the access token has already expired, never an expired token. Only an
  HTTP 400 with `error_code` `refresh_token_not_found`, `refresh_token_already_used`,
  `session_not_found` or `session_expired` is authoritative: record a `session-dead` marker keyed by a
  hash of that renewal token. The extension then makes no account network call until the app signs in
  or out again; the app's next read removes the dead session and the app shows its normal signed-out
  state.
- **Lanes (hand-routed per ADR 0001).**
  - App (`WebBridgeRouter.swift`): `{kind:"authSession", op:"get"|"set"|"remove"}` for the one
    session key. `set` and `remove` are short `flock` transactions that also clear any renewal claim,
    so a renewal finishing after a sign-out or account switch fails its compare-and-swap and is
    discarded. The app web view (bundled content only, as today) still receives the full session; the
    "renewal token never reaches JavaScript" rule is about the extension. The app's supabase-js client uses a
    `SupportedStorage` that sends only the session key to this lane; every other key supabase-js uses
    (`-user`, code-verifier keys) stays in the existing `safeStorage()`, so nothing supabase-js touches
    is ever refused or throws.
  - Extension (`SafariWebExtensionHandler.swift`): `{kind:"authAccess"}` only. It replies
    `{status:"ok", accessToken, userId, sessionId, expiresAt}` (claims decoded natively from the access
    token), `{status:"none"}` or `{status:"dead"}`. It never returns the renewal token and there is no
    extension write or remove of the session.
- **JS can never renew.** Both supabase-js clients get a `fetch` wrapper that rejects any request to
  `/auth/v1/token?grant_type=refresh_token` with a network-style `TypeError`, which supabase-js treats
  as retryable (it keeps the session). The app's client sets `autoRefreshToken: false`; the session
  native returns is always fresh enough that supabase-js never decides to renew.
- **Migration lives inside the app's storage read.** `getItem` for the session key reads the Keychain
  first. If the Keychain is empty, it copies the `localStorage` value to the Keychain, reads it back,
  and returns the result of `SharedAuthSession.current()`, so native renews the (usually expired)
  migrated token before supabase-js ever sees it; the web-storage copy is deleted only after that.
  If the Keychain write fails, it returns the web-storage value unchanged. Once the Keychain holds a
  session the web-storage copy is never read again. This keeps the first launch after the update
  signed in. Known, unchanged behavior: when native cannot renew (offline) and the token is past
  expiry, supabase-js's retry backoff takes about 25 s and then reports no session for that call,
  exactly as offline launches do today. The move is one-way: an older app build installed
  later finds no session and asks the person to sign in again (QA note; settings are kept in the App
  Group).
- Until someone opens the updated app once, the extension finds no shared session (D4).

### D-2. Narrow extension authority (`SettingsBridge` and handler lanes)

Replace the single `admitsAtomicCommands: Bool` with an explicit per-lane policy for the extension:

| Lane or command | App | Extension | Notes |
|---|---|---|---|
| `initialize` | yes | refused | Unchanged. |
| `scope` that changes account, session or generation | yes | refused | Sign-in, sign-out and account switch stay app-only. |
| `scope` that is a no-op (same account and same `sessionId`) | yes | **admitted** | `SyncService.reconcileAtomic` confirms scope before reading; native checks the no-op before admitting and returns the bytes unchanged. |
| `acknowledge`, same scope | yes | **admitted** | This is how both the answer to a send and the open-time account read are saved (`reconcileAtomic` reads the canonical row, then acknowledges it). Already a no-op when the captured scope differs. |
| `acknowledge`, same scope, receipt older than the stored anchor (same lineage) | throws (unchanged) | **no-op, returns current bytes** | Happens when the app acknowledged a newer revision while the extension's read was in flight (Mac app and Safari both alive). Treated as "already superseded", not an error. |
| coarse modern `set` | yes | refused | Unchanged. |
| `settingsIntent`, `get`, `settingsAdopt` | yes | yes | Unchanged. |
| `authSession` get/set/remove | yes | refused | App only. |
| `authAccess` | n/a | **admitted** | Access token and claims only (D-1). |
| account status write (`lastSyncedAt`, `pendingUpload`, `cloudReachable`) | yes | **admitted** | Only for the account id already recorded by the app; never changes account id or email. |

T9 (`ExtensionBridgeAuthorityTests`) is updated deliberately, with the reasons above; refusals for
every other command stay pinned.

### D-3. Extension sync runner (`packages/ext-safari/lib/extension-sync.ts`)

- **Build gate.** Built only when the build already selects modern cloud settings
  (`VITE_MODERN_SETTINGS_SYNC_ENABLED=true` with Supabase configured, the `reinstallAware` condition)
  **and** a dedicated flag `VITE_SAFARI_SETTINGS_SYNC_ENABLED=true`. Every 2.x build folds it away;
  `scripts/bundles/identity.mjs` stays byte-identical for default builds. Turning the flag off is the
  rollback.
- **Composition (existing parts):** a `SettingsCache` over a `WKWebViewStorageAdapter` constructed
  with an injected `StillMessagePort` (small refactor) whose `postMessage` wraps
  `browser.runtime.sendNativeMessage` and unwraps the handler's `{settings: "<json>"}` envelope (empty
  string means absent, a missing field means unavailable, as `ChromeStorageAdapter.readNativeAuthority`
  does); a native-backed auth port that answers `currentUserId` / `currentSettingsSession` from
  `authAccess` plus an authenticated `GET /auth/v1/user` with that access token (the existing
  verification, cached for one runner pass; `currentSettingsSession` reuses the pass's `authAccess`
  reply and asks again only when that token is within the 5-minute margin);
  `SupabaseBackendPort({ modernSettings: true, routeProfile })` over a supabase-js client created
  with the `accessToken` option, whose callback returns the pass's token (functions only; on this
  client `client.auth` throws on access and must never be touched, so no auth options apply); and
  `SyncService` with no identity store. The cache is built without `atomicOwnership`, so hydration
  uses `get` and never the refused `initialize`.
- **Construction is lazy and after the checks.** Nothing is constructed when the background starts or
  on the content-script `reconcile` message. On a runner trigger, the cache and `authAccess` checks run
  first (native reads only); the supabase-js client and `SupabaseBackendPort` are constructed only
  after they pass, because the `accessToken` client calls its callback at construction.
- **Triggers.** A new runtime message `{kind:"still:account-sync", reason:"open"|"committed"}`, sent
  by the popup and the settings page on mount and after each successful `commitIntent` (this also
  wakes a suspended background). The runner accepts it only when `sender.url`, ignoring query and
  hash, equals `browser.runtime.getURL()` of the popup page or the settings page (which Safari may
  show in a tab, so `sender.tab` is not used). Content scripts carry the web page's URL and the
  `tiktok-blocked` extension page is excluded by name, so neither can trigger it. Also: `online` while
  awake and the quiet alarm, both scheduled only from these triggers. The existing `reconcile` listener
  stays network-free and schedules nothing. Passes are serialized: one in flight, and triggers that
  arrive meanwhile coalesce into a single trailing pass.
- **Sequence per trigger.** Await `cache.hydrate()`; require `currentRecord().atomic`, an `authAccess`
  reply of `ok`, `userId === scope.accountId`, `sessionId === scope.sessionId`, and no ownership pause.
  Otherwise stop with **no network call**. Then `await sync.resume(scope.accountId, false)` (modern
  sync ignores entitlement; `resume` never queries purchases), then `suspend()`. The runner never calls
  `onSignedIn`, `onEntitlementConfirmed`, `signOut` or `deleteAccount`; its auth port throws if asked.
- **After an acknowledgement that changed settings**, call the background's existing
  `reconciler.reconcile()` (a native read, no network), so `browser.storage.local` and open tabs follow
  at once.
- **Realtime:** not used. The runner's backend defines `subscribeToSettingsChanges` as a function that
  never reports status (so `startRealtime` never falls back to the legacy profile websocket); the
  needed read comes from `resume()`'s catch-up.
- **`SyncService.suspend()`** (new): stops write-through, the 5 s refresh timer, the retry timer and
  realtime, without touching auth or scope.
- **Status shown in the popup** (wording agreed with the ISS-0061 lane):

  | Situation | Popup sync card |
  |---|---|
  | Sent and acknowledged | Synced, with the time |
  | Pending, offline or server unreachable | Waiting to sync (will retry) |
  | Signed in on the app, but the extension has no shared sign-in yet (D4) | "Open Still once to turn on sync from Safari" |
  | Session dead, or record paused for ownership | "Open Still to finish syncing" |
  | Signed out | Unchanged local-only state |

### D-4. What the extension may send

Through `fetch` from the extension background: the protocol-2 request built by
`pendingSettingsRequest` from an entry already in the App Group, the authenticated canonical settings
read, and `GET /auth/v1/user`. Through native, from the extension process: the renewal request. Paths
are the packaged settings fields only (validated natively at commit and again by
`readSettingsOperationRequest`). No tab, URL, title, page, video, search or page-load timing exists in
this path; the runner has no tab access (no `tabs` permission) and never runs from content scripts.

### D-5. Privacy, App Review, analytics

- Extension `PrivacyInfo.xcprivacy`: add `OtherDataTypes` (settings) for App Functionality and add App
  Functionality to the existing `UserID` entry, because the extension now sends them. The app's manifest
  already declares both. App Store privacy labels are per app and already list settings and user id for
  App Functionality; confirm no portal change during release.
- No new required-reason API (Keychain is not one). No background mode. No new Safari permission
  prompt. Mac extension may gain the outgoing-network sandbox entitlement (D3).
- Privacy policy, product docs and support copy: describe the new timing honestly (Safari edits sync on
  their own; changes from other devices reach Safari when the popup or the Still app is opened, per D1).
- Analytics: no new events, no change to the ADR 0004 schema.
- ADR 0005 "Safari extension may send pending settings under the app's session" records the change to
  the U3-W4 authority split and its limits (D-2).

## Scope

### In scope

iPhone/iPad Safari and Safari on Mac (same extension), modern cloud settings builds (V3), the shared
session store with native renewal and migration, the narrow bridge authority, the extension runner and
triggers, popup status states, privacy manifest, ADR, docs and a solution entry.

### Out of scope

2.x legacy builds (no change), Chrome/Firefox (already sync), realtime in the extension, any server or
migration change, host permissions, analytics changes, sign-in from the Safari popup.

## Owner and root decisions

| Id | Decision | State | Recommendation |
|---|---|---|---|
| D1 | With the Still app closed on a device, changes made on other devices, **including turning a blocker on**, do not take effect in that device's Safari until its Safari popup (or settings page) or the Still app is opened. Options: (a) popup or app open only; (b) also a randomly timed quiet background read while Safari keeps the extension awake (timing unrelated to page loads; reliability on iOS checked in Unit 0(e)); (c) on every supported page load (rejected: reveals visit timing). | **Owner to choose** | (a), plus (b) if Unit 0(e) shows it fires reliably. |
| D2 | The Safari extension becomes a second, narrowly limited account client on the device (D-2), recorded in ADR 0005. | Root/owner awareness | Accept; it is the only way to meet plan 1 without a second engine or server work. |
| D3 | Signing changes on the Mac: the Mac extension needs the outgoing-network sandbox entitlement for native renewal, and, if Unit 0(b) shows the App Group cannot be a Keychain access group on macOS, a `keychain-access-groups` entitlement on the Mac app and extension. Not a host permission and not visible to people; QA packages must be re-signed. | **Root/owner to approve** | Accept. Without it, Safari Mac edits sync on their own only while the access token is valid (up to an hour after the Mac app last ran). |
| D4 | People must open the updated app once before Safari-only sync starts. Until then the popup shows a one-time "Open Still once to turn on sync from Safari" card. This is a one-time setup step, not the ongoing "open the app to sync" copy the owner declined. | **Owner to confirm** | Accept. |
| D5 | Privacy review sign-off for the extension privacy manifest change (D-5). | Owner sign-off | Approve; no new data type for the product overall. |

No new host permission is required, so no host-permission review is triggered.

## Work units (implementation only after root approval)

### 0. Device spike (half a day; needs the owner's iPhone for parts of it)

- On iPhone Safari and Safari Mac, with a throwaway QA build: (a) an authenticated `fetch` (with
  Authorization header) from the extension background to the QA `sync-settings` function and Auth
  succeeds with the four host permissions only; (b) the extension and app read and write a Keychain item
  in the App Group access group on iOS and macOS; (c) the real exchange (native renewal, user check,
  canonical read, write, acknowledge) triggered by a popup message completes after the popup closes,
  timed on Wi-Fi and cellular; (d) whether Safari lets content scripts call `sendNativeMessage`, and
  whether the handler receives any sender identity; (e) whether `alarms` fire for the Safari background
  on iOS while Safari is in use (for D1 b).
- Read hosted QA Auth settings read-only: refresh rotation, reuse interval, JWT expiry, and how the
  hosted Auth version treats a renewal token whose child was never used (this bounds the crash window).
- Exit: written results in this plan; stop and report if (a) or (b) fails.
- Verification: recorded spike results, no product code merged.

### 1. StillKit: shared session store and native renewer

- Files: new `apps/apple/StillKit/Sources/StillKit/SharedAuthSession.swift` (injectable transport and
  clock), tests `SharedAuthSessionTests.swift`.
- Verification: `swift test`; tests 6, 12 and the dead-session latch below.

### 2. Bridge lanes and narrow authority

- Files: `SettingsBridge.swift` (per-lane policy and extension stale-acknowledge no-op),
  `SafariWebExtensionHandler.swift` (`authAccess`, status write), `WebBridgeRouter.swift` (`authSession`),
  `AccountSyncStatus.swift` (narrow status write), `ExtensionBridgeAuthorityTests.swift`, native config
  (Info.plist build settings, `apps/apple/scripts/release-env-guard.sh` / `release-env-state.mjs`),
  Mac extension build settings / entitlements (D3).
- Verification: `swift test`; `xcodebuild` iOS and macOS schemes with a private DerivedData.

### 3. App: session moves to the Keychain

- Files: `packages/app-webview/src/main.ts`, new `packages/core/src/sync/shared-session.ts` (native
  `SupportedStorage` for the session key, renewal-blocking fetch), tests.
- Verification: test 13; app sign-out over the new storage completes and emits `SIGNED_OUT`.

### 4. Core runner pieces

- Files: `packages/core/src/sync/service.ts` (`suspend()`), `packages/core/src/storage/wkwebview-adapter.ts`
  (port injection), a native-backed auth port, `packages/core/src/sync/index.ts` exports.
- Verification: `pnpm --filter @still/core test` including test 11.

### 5. Safari extension runner and wiring

- Files: new `packages/ext-safari/lib/extension-sync.ts` + tests, `packages/ext-safari/entrypoints/background.ts`,
  the popup and settings-page mount and commit sites (`entrypoints/popup/*`, `entrypoints/options/*`,
  `lib/safari-v3-runtime.ts`), `packages/ext-safari/package.json` (supabase-js, already in the
  workspace).
- Verification: `pnpm --filter @still/ext-safari test` and `build`; tests 1 to 4, 7 to 10, 14; bundle
  identity.

### 6. Privacy, ADR and docs

- Files: `apps/apple/Still/Shared (Extension)/PrivacyInfo.xcprivacy`, new
  `docs/adr/0005-safari-extension-sends-pending-settings.md`, `docs/ARCHITECTURE.md` (settings and
  account flow), `docs/PRODUCT.md` (sync section, including the D1 timing), support/FAQ copy if it
  describes sync timing, new `docs/solutions/` entry.
- Verification: plist lint; docs reviewed against the final behavior.

## Tests to write first

Tests 1 to 6, 8, 9 and 11 to 14 must fail on current code (record the failing output). Tests 7 and 10
are regression guards that must stay green.

1. **Extension edit uploads with the app not running** (`ext-safari` vitest): a fake native host that
   replies in the real handler's envelope shape and is driven by the real TypeScript `AtomicSettingsWriter`
   holds a signed-in record and an `authAccess` session; a popup intent is committed and
   `still:account-sync` sent; with no app `SyncService`, the runner sends exactly one protocol-2 request
   and the record has no pending entry after the acknowledgement.
2. **Offline edit retried:** the first send rejects; the entry stays in the App Group; the next trigger
   (popup open, then quiet alarm) resends the same write id with a byte-identical body; accepted once.
3. **Per-field merge with concurrent edits:** Chrome (or the app) changed `services.youtube` at the server
   while the extension changed `services.tiktok` from the older receipt; both survive on the server and
   in the App Group. App and extension sending the same entry at once produce one accepted write. The
   extension's read acknowledged after the app acknowledged a newer revision is a no-op: no error, no
   status regression, no pending entry left.
4. **Fencing:** no shared session, or `status:"dead"` → zero network calls (fetch spy); record scope for
   another account or another `sessionId` → no upload and no scope change; the app signs out mid-flush →
   the late acknowledgement is a no-op and nothing else is sent; account switch A to B → A's entry is
   never sent under B; an unhydrated or non-atomic record → zero network calls; the runner never calls
   sign-out, `onSignedIn` or `onEntitlementConfirmed`.
5. **Native authority (Swift):** in addition to today's admitted `settingsIntent`, `get` and
   `settingsAdopt`, the extension bridge admits `acknowledge` and a no-op `scope` (and treats an older
   same-lineage acknowledge as a no-op); it refuses `initialize`, scope changes, coarse modern `set` and
   `authSession`; the status lane cannot change account id or email; `authAccess` never returns a
   renewal token.
6. **Single native renewer:** two simulated processes with an expiring access token produce exactly one
   renewal request; the second reads the saved result; no file lock is held while the request is in
   flight; a claim abandoned by a dead process expires and is reclaimed; a waiter whose bounded wait
   ends returns the stored session without hanging; a renewal that finishes after the app signed out or
   switched accounts fails its compare-and-swap and is discarded; a network failure, timeout, 5xx or 401
   keeps the stored session and never sets the dead marker; only the listed 400 error codes set it;
   `authAccess` never returns an already-expired token.
7. **No new host permissions:** `manifest-permissions.test.ts` unchanged and green.
8. **Exact network surface:** captured requests are only `sync-settings` (or the QA route), the canonical
   read and `/auth/v1/user`; bodies have exactly the protocol-2 keys and operation keys; every path is a
   packaged settings field; no string looks like a URL or hostname.
9. **No network at page-load moments:** a fresh background started by a content-script `reconcile`
   message, holding a shared session with an expired access token, makes zero network calls (including
   no native renewal) and schedules no alarm; `still:account-sync` from a content-script sender or from
   the `tiktok-blocked` page is ignored; from the settings page shown in a tab it is accepted; a
   non-atomic or mismatched record never constructs the supabase-js client.
10. **2.x bundles unchanged:** `node scripts/bundles/identity.mjs` before and after.
11. **`suspend()`** stops write-through, the refresh and retry timers and realtime without sign-out or
    scope change.
12. **Keychain item attributes:** access group, `AfterFirstUnlockThisDeviceOnly`, data-protection keychain
    on macOS, size cap; the extension has no session write or remove lane.
13. **Migration:** first launch after the update with only an **expired** `localStorage` session yields
    a non-null `INITIAL_SESSION` (native renewed it) with no blocked JS renewal attempt; the copy is
    verified before deletion; a failed
    Keychain write keeps the web-storage session; JS renewal requests are rejected as retryable and never
    remove the session.
14. **Content-script isolation:** content-script bundles do not import the runner, the auth port or the
    session modules (bundle-graph check).

## Acceptance scenarios (owner retest on an installed package)

1. Given every surface signed in to QA A, the Mac app running, and the Still app force-quit on the
   iPhone, when TikTok Blocker is turned Off in the iPhone Safari popup, then Chrome, the Mac app and
   Safari on the Mac show it Off within seconds (XD-01/XD-03 timing; IOS-28 area exploratory).
2. Given the Mac app quit, after scenario 1, when the Safari Mac popup is opened, then it shows the
   iPhone's change, and Mac Safari blocking follows it.
3. Given airplane mode on the iPhone, when a switch is changed in the Safari popup, then nothing changes
   elsewhere; when the network returns and the popup is opened, the change reaches the other devices
   within seconds (XD-05 popup variant).
4. Given the iPhone app closed, when Chrome changes a switch and the iPhone Safari popup is then opened,
   then the popup shows the new value and open tabs block by it.
5. Given the iPhone app signed out, when the Safari popup changes a switch, then it stays local and no
   other device changes.
6. Given the iPhone app switched from QA A to QA B, when the Safari popup changes a switch, then only QA
   B's devices change, never QA A's.
7. Given the app unopened for over an hour (expired access token), when the popup changes a switch, then
   it still reaches other devices, and the next app open stays signed in.
8. Given the Mac app quit, when the Safari Mac popup changes a switch, then Chrome shows it within
   seconds (requires D3).
9. Given an update installed but the app never opened since, when the Safari popup changes a switch,
   then the popup shows "Open Still once to turn on sync from Safari"; after opening the app once, later
   Safari edits sync on their own.

## Risks and recovery

| Id | Risk | Prevention | Recovery |
|---|---|---|---|
| R1 | Renewal token reuse revokes the shared session | One native renewer per device via a fenced claim; JS renewal blocked; suspension guard during the request; compare-and-swap save; Unit 0 checks hosted handling of an unused child | Person signs in again on the app |
| R2 | Access token (up to one hour) readable by extension contexts | Renewal token never leaves native; `authAccess` returns the access token only; runner only in the background (test 14); page scripts cannot reach `browser.runtime` | If Unit 0(d) shows content scripts can call native messaging and review rejects the residual, move the settings requests to native (Option B) |
| R3 | Migration loses an existing session | Migration inside `getItem`; copy, read back, then delete; web-storage copy never read once the Keychain holds a session | Person signs in again; settings stay in the App Group |
| R4 | Safari stops the background before a send finishes | The entry stays durable; idempotent retry on the next trigger | Automatic |
| R5 | Extra load on the QA backend's connection budget (PR441) | Short bursts only, no realtime, user check cached per pass | Lower the retry rate |
| R6 | Mac needs signing changes | D3; Unit 0(b) first | Ship iPhone first, Mac when re-signed |
| R7 | The extension writes account answers into the App Group | Native policy D-2; scope fencing in the record writer; ADR 0005 | Turn `VITE_SAFARI_SETTINGS_SYNC_ENABLED` off |
| R8 | A compromised extension context forges an acknowledgement (native cannot verify the server's receipt) | Same trust boundary as today's intent lane; scope must match; revision cannot go backwards | Sign out and in on the app resets the scope and anchor |
| R9 | Downgrade to an older app build after migration | One-way move documented for QA | Sign in again |
| R10 | Device restored from backup loses the session (ThisDeviceOnly) | Intended; settings stay local | Sign in again |

Rollback: turning `VITE_SAFARI_SETTINGS_SYNC_ENABLED` off returns Safari to today's behavior (edits wait
for the app) without touching saved settings; the Keychain session stays valid for the app.

## External and human gates

- Unit 0 needs the owner's iPhone for the Safari spike (or an iOS simulator for parts a to c, with
  device confirmation later).
- Read-only check of hosted QA Auth settings (standing read-only route; no CLI in the main checkout).
- Owner choice on D1 and confirmation of D4; sign-off on D5; root/owner approval of D3; awareness of D2.
- Device retest of the acceptance scenarios on a new receipt-bound package.

## Review record

Round 2 (security lens, feasibility) changed the renewer so no file lock is held across the network
(iOS `0xdead10cc`), added a fenced claim with compare-and-swap, timeouts and suspension guards, made
migration return a natively renewed session, defined the authoritative error codes, replaced the
`sender.tab` check with exact page URLs, and constructed the extension client only after its checks.

Round 1 doc review (coherence, feasibility, security lens, adversarial, product lens) changed the
design: the renewal token no longer reaches extension JavaScript and the JS-side lease was replaced by a
single native renewer; triggers moved to a dedicated extension-page message because popup edits go
straight to native and the popup's own open message is the page-load `reconcile`; the runner's entry
point, hydration, envelope unwrap, tab refresh, stale-acknowledge handling, migration-in-`getItem`,
non-throwing key handling, popup status states, D1/D4 framing and the honest outcome wording were added.

## Sequencing note for the root

This lane touches `SafariWebExtensionHandler.swift` and `SettingsBridge.swift`, which the ISS-0050 lane
also changes, and `AccountSyncStatus.swift` plus the popup sync card, which ISS-0061 may change.
Implement after ISS-0050 merges and rebase on it; agree the status fields and wording with ISS-0061.
