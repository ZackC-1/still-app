# Native sync card shows the last successful sync time

Status: implemented and locally verified; owner device retest pending

ISS-0061 (minor change request): the iPhone Still app's Settings sync card says "Synced with your
account." but not when. Chrome's popup shows "Synced with your account. · Oct 15, 2:24 PM".

## Root cause

The iPhone and Mac apps do not have a native (SwiftUI) sync card. Both render the shared Svelte
`SyncCard` inside the app's web view, through `AppleSettingsHost.svelte` →
`createAppleSettingsSync()` → `AppleSettings.svelte` → `SyncCard`. The controller already holds
the right timestamp (`lastSyncedAt`, set by `SyncService` only after a successful cloud exchange,
including the refresh after another device's change, and cleared on sign-out). The Apple
presentation dropped it: `createAppleSettingsSync` built only a status line and `SyncCard` had no
field for a time. The Mac app uses the same host, so it had the same gap.

## Approach

- Add an optional `lastSyncedAt` to the shared `SyncCard` account props. When present, the status
  line renders the same compact summary as the Chrome popup (ISS-0056, on main): status text,
  a separator, and the time in a `<time>` element. On success the "Last synced" label is for
  screen readers only; while syncing or after a failure it stays visible so an earlier time is
  never read as the current upload succeeding.
- Move the popup's compact summary into one shared `SyncSummary` component used by both the
  popup and the sync card, so the markup, label rule and date format cannot drift. The time sits
  in an `aria-live="off"` span so its advancing minute is not re-announced; an unrepresentable
  value shows the status alone.
- Fix a popup defect found on the way: Svelte drops whitespace at the end of an element, so the
  visible label read "Last syncedOct 15" while syncing or after a failure.
- `createAppleSettingsSync` passes the controller's `lastSyncedAt`, except while an account
  deletion is running or has failed (those statuses are about the account, not sync).
- `AppleSettings` forwards it to `SyncCard`.
- Chrome's settings page does not pass the new field, so it is unchanged; Chrome's popup renders
  the same DOM through the shared component, plus the restored space.
  ISS-0056's layout question is still open with the owner; this follows what Chrome does today.
- No Swift change, no new data source, no analytics, no Safari popup change (other lanes own the
  Safari popup and its bridge).

## Tests (written first, must fail on main)

- Apple cloud composition (`apple-settings-cloud.test.ts`, the real host over the real sync
  service with only network and native ends faked): after sign-in the card shows the success
  line with the time of that sync; after another device's edit converges, the time moves to the
  new exchange; before any successful sync (held rollout) there is no time; signed out there is
  no time; a later failure keeps the earlier good time with a visible "Last synced" label.
- Mac platform: the same host on `platform: "mac"` shows the time.
- `createAppleSettingsSync` unit: passes `lastSyncedAt`, null before a sync, none signed out,
  none during delete flows.
- `SyncCard`: no time and unchanged markup when the field is absent (Chrome settings page).

## Retest (owner, device)

IOS-40/41, XD-06, MAC-38 area: signed in, the app card shows "Synced with your account. · <date,
time>"; edit on another device and watch the time advance; sign out and the time disappears.

## Risks

- Layout may change again when the owner answers ISS-0056; the summary now lives in one place.
- The legacy 2.x `App.svelte` screens keep their own inline format (their bundles stay as shipped).
- The Safari popups still show no time (their host passes none); noted for a later lane.
