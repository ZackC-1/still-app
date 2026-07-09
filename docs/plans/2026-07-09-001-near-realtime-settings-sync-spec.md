---
title: "feat: near-realtime settings sync with server-authoritative ordering"
type: feat
status: proposed
date: 2026-07-09
owner: autonomous-agent
---

# feat: near-realtime settings sync with server-authoritative ordering

## Summary

Make Still settings converge across iOS, macOS, Safari extensions, Chrome, and Firefox without manual refreshes. The latest server-accepted settings write becomes the canonical state. Active signed-in Pro surfaces receive updates through Supabase Realtime and apply them immediately. Same-device app/extension storage is also refreshed so content scripts and settings UIs converge without requiring the user to toggle, relaunch, or manually restore.

The server, not a device clock, is the ordering authority. Clients may keep using local timestamps for optimistic UI, but cross-surface conflict resolution must use a server-stamped monotonic version and server timestamp.

## Product Goal

When a Pro user changes any Still setting on any signed-in surface, all other active signed-in Pro surfaces should match the new setting almost immediately. If multiple surfaces change settings close together, the write accepted latest by the server wins. Users should not need to reload the app, reopen the extension popup, restore purchases, or manually press a sync button.

## Definitions

- **Surface:** iOS app, macOS app, Safari extension on iOS/macOS, Chrome extension, Firefox extension.
- **Settings:** the full `StillSettings` object: global on/off, per-service toggles, pauses, and any future settings stored in `public.profiles.settings`.
- **Cloud profile:** the user row in `public.profiles`.
- **Server version:** a monotonic integer on `public.profiles` incremented by the database on every accepted settings write.
- **Server timestamp:** `clock_timestamp()` stamped by the database on every accepted settings write.
- **Write id:** a client-generated UUID for one logical settings write. Used only for dedupe/diagnostics, not authorization.
- **Near realtime:** active online surfaces converge within 2 seconds p95 and 5 seconds worst-case under normal network conditions.
- **Latest wins:** the profile update with the highest server version wins. If version is unavailable during migration, the newest server timestamp wins. Device-local `settings.updatedAt` is never used for cross-surface ordering after this feature lands.

## Non-Goals

- Do not make sync available to free users. Profile writes remain gated by `still_sync = true`.
- Do not sync entitlement state inside the settings blob. Entitlements remain server-authoritative through RevenueCat/Supabase reconcile.
- Do not add a manual "sync now" button as the primary mechanism.
- Do not rely on Apple sandbox purchase completion for this feature.
- Do not change product pricing, App Store metadata, or RevenueCat products.

## Current State

- `public.profiles` stores one row per user with `settings jsonb` and `updated_at timestamptz`.
- Profile write RLS already requires the user to own the row and have `entitlements.still_sync = true`.
- `SyncService` mirrors cloud profile state on sign-in and writes local edits through `BackendPort.writeProfile(settings)`.
- `SettingsCache` currently resolves conflicts with `settings.updatedAt`, which is stamped by the writing device.
- Apple app and Safari extension share local settings through the App Group store `group.com.chartash.still`.
- Chrome/Firefox use extension storage and storage-change listeners for local propagation.
- Cross-device sync currently happens on sign-in/resume/reconcile/refresh paths, not as a continuous realtime subscription.

## Required Behavior

### B1. Server-authoritative write order

- Every cloud settings write must go through a database RPC.
- The RPC must derive the user id from `auth.uid()`. It must never accept a user id from the client.
- The RPC must verify the caller has `still_sync = true`.
- The RPC must upsert/update only the caller's own profile row.
- The RPC must increment `settings_version` exactly once for every accepted write.
- The RPC must stamp `settings_server_updated_at = clock_timestamp()`.
- The RPC must store `settings_last_write_id` for observability and echo suppression.
- The RPC must return the full canonical envelope after the write.
- Direct authenticated INSERT/UPDATE grants on `public.profiles` must be removed or denied once all clients use the RPC.

### B2. Server envelope

All cloud read/write/realtime code must operate on this envelope:

```typescript
export interface SyncedSettingsEnvelope {
  readonly settings: StillSettings;
  readonly version: number;
  readonly serverUpdatedAt: string; // ISO timestamp from the database
  readonly lastWriteId: string | null;
}
```

Rules:

- `version` is the primary ordering key.
- `serverUpdatedAt` is secondary only for migration/backfill compatibility.
- `lastWriteId` must not be trusted for authorization.
- `settings.updatedAt` remains allowed for local UI optimism, but it is not the cloud ordering key.
- When a server envelope is applied locally, the local cache must persist both the settings and sync metadata. Do not discard `version`.

### B3. Realtime subscription

- Every signed-in entitled surface must subscribe to its own profile row.
- Subscription filter: `schema: public`, `table: profiles`, `event: UPDATE`, `filter: id=eq.<auth.uid()>`.
- The subscription must start after entitlement is confirmed.
- The subscription must stop on sign-out, account deletion, entitlement false, or identity switch.
- On an incoming profile event, parse the envelope and apply it only if it is newer than the local cloud metadata.
- Events for older/equal versions must be ignored.
- Events from the same surface's own write may be ignored by `lastWriteId` only if the local canonical metadata already matches or exceeds the event version. Never ignore a higher version only because the write id is recognized.
- If Realtime disconnects, the client must mark realtime stale and run a one-shot `readProfile()` on reconnect before trusting new events.

### B4. Optimistic local writes

- A user interaction should update the local UI immediately.
- The write should be sent to the server in the background.
- On RPC success, replace local sync metadata with the returned server envelope.
- On RPC failure, keep the local setting for the current surface but mark cloud reachability false. The next local edit, reconnect, or resume must retry by sending the latest local settings.
- If a newer remote server version arrives while a local write is in flight, the newer remote version wins. Pending older local writes must not overwrite it after they complete.

### B5. Same-device app/extension propagation

- Apple app surfaces must continue writing settings to the App Group store for Safari extension compatibility.
- The App Group store must also persist cloud sync metadata: `version`, `serverUpdatedAt`, and `lastWriteId`.
- Safari extension content/background code must be able to learn local settings changes without the user reopening the app.
- Use the fastest available host mechanism per platform:
  - Chrome/Firefox: `chrome.storage.onChanged` / browser storage change events.
  - macOS Safari: native app-to-extension messaging where available, plus App Group read on extension/background activation.
  - iOS Safari: App Group read on extension activation plus a bounded polling or focus/visibility refresh path for active pages if native push is unavailable.
- Already-open pages must re-evaluate rules after a settings update. If a full DOM rollback is not possible for a specific site, navigation/reload may be needed for that page, but the extension must have the new setting without manual user action.

### B6. Startup/resume convergence

- On app launch, extension background wake, popup open, options open, Safari extension activation, and browser online/reconnect:
  - hydrate local settings and sync metadata;
  - confirm session identity;
  - confirm entitlement or use a fresh valid entitlement cache according to existing entitlement rules;
  - read the cloud profile once;
  - apply the newest envelope;
  - start/restart the realtime subscription if entitled.
- A surface must never seed a different user's empty cloud profile from the previous user's local settings.

### B7. Auth and security

- Only authenticated users can read their own profile row.
- Only authenticated entitled users can write settings through the RPC.
- Users cannot directly update another user's profile.
- Users cannot directly update their own profile by bypassing the RPC after the migration completes.
- The RPC must validate that `p_settings` is a JSON object.
- The client must validate parsed settings with the existing settings parser before applying.
- No secrets, service-role keys, or entitlement writer secrets may be exposed to app or extension clients.
- Realtime must be scoped to the user's own row and must rely on RLS.

## Database Design

### Migration: `0009_profile_settings_server_clock.sql`

Add server-authoritative metadata:

```sql
alter table public.profiles
  add column if not exists settings_version bigint not null default 0,
  add column if not exists settings_server_updated_at timestamptz not null default now(),
  add column if not exists settings_last_write_id uuid;
```

Backfill existing rows:

```sql
update public.profiles
set settings_server_updated_at = coalesce(updated_at, now())
where settings_server_updated_at is null;
```

Create an RPC:

```sql
create or replace function public.write_profile_settings(
  p_settings jsonb,
  p_write_id uuid
) returns table (
  settings jsonb,
  settings_version bigint,
  settings_server_updated_at timestamptz,
  settings_last_write_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_entitled boolean;
  v_server_time timestamptz;
begin
  if v_user_id is null then
    raise exception 'auth required' using errcode = '28000';
  end if;

  if p_write_id is null then
    raise exception 'write id required' using errcode = '22023';
  end if;

  if jsonb_typeof(p_settings) <> 'object' then
    raise exception 'settings must be a json object' using errcode = '22023';
  end if;

  select e.still_sync into v_entitled
  from public.entitlements e
  where e.user_id = v_user_id;

  if coalesce(v_entitled, false) is not true then
    raise exception 'still_sync entitlement required' using errcode = '42501';
  end if;

  v_server_time := clock_timestamp();

  insert into public.profiles (
    id,
    settings,
    updated_at,
    settings_version,
    settings_server_updated_at,
    settings_last_write_id
  )
  values (
    v_user_id,
    p_settings,
    v_server_time,
    1,
    v_server_time,
    p_write_id
  )
  on conflict (id) do update
    set settings = excluded.settings,
        updated_at = v_server_time,
        settings_version = public.profiles.settings_version + 1,
        settings_server_updated_at = v_server_time,
        settings_last_write_id = excluded.settings_last_write_id;

  return query
    select p.settings,
           p.settings_version,
           p.settings_server_updated_at,
           p.settings_last_write_id
    from public.profiles p
    where p.id = v_user_id;
end;
$$;
```

Lock down grants:

```sql
revoke execute on function public.write_profile_settings(jsonb, uuid) from public;
grant execute on function public.write_profile_settings(jsonb, uuid) to authenticated;
```

Add Realtime publication:

```sql
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end
$$;
```

After all clients are migrated to the RPC, remove direct profile write access:

```sql
revoke insert, update on public.profiles from authenticated;
drop policy if exists "profiles: insert own entitled" on public.profiles;
drop policy if exists "profiles: update own entitled" on public.profiles;
```

Keep `select` policy unchanged.

### Rollback

Rollback is forward-only:

- Do not remove columns from production immediately.
- If the RPC path fails, create a new migration that temporarily restores the entitled insert/update policies and grants.
- Keep `settings_version` columns in place until all production clients are confirmed not to depend on them.

## Core Code Design

### Types

Add these core types near the existing sync/profile code:

```typescript
export interface SyncedSettingsEnvelope {
  readonly settings: StillSettings;
  readonly version: number;
  readonly serverUpdatedAt: string;
  readonly lastWriteId: string | null;
}

export interface SettingsSyncMetadata {
  readonly version: number;
  readonly serverUpdatedAt: string;
  readonly lastWriteId: string | null;
}
```

### BackendPort

Replace or extend profile methods:

```typescript
interface BackendPort {
  readProfile(): Promise<SyncedSettingsEnvelope | null>;
  writeProfile(settings: StillSettings, writeId: string): Promise<SyncedSettingsEnvelope>;
  subscribeToProfile(
    userId: string,
    onEnvelope: (envelope: SyncedSettingsEnvelope) => void,
    onStatus?: (status: "subscribed" | "disconnected" | "error") => void,
  ): () => void;
}
```

Implementation requirements:

- `readProfile()` selects `settings`, `settings_version`, `settings_server_updated_at`, `settings_last_write_id`.
- `writeProfile()` calls `rpc("write_profile_settings", { p_settings, p_write_id })`.
- `subscribeToProfile()` uses Supabase Realtime with a row filter.
- All parsing must be defensive. Invalid settings or invalid metadata are treated as no profile/update ignored, not as a crash.

### Settings cache

Do not rely only on `settings.updatedAt` for cloud conflict resolution.

Add a cloud-aware apply path:

```typescript
applySyncedEnvelope(envelope: SyncedSettingsEnvelope): boolean
```

Rules:

- If no local sync metadata exists, apply the envelope.
- If `envelope.version > local.version`, apply.
- If `envelope.version === local.version`, ignore unless this is the current write acknowledgement and local metadata is missing.
- If `envelope.version < local.version`, ignore.
- Persist settings and metadata together atomically where the host storage supports it.
- Notify subscribers only when settings or metadata actually change.

Keep existing local mutation APIs:

- `setGlobalOn`
- `setService`
- `pauseHost`
- `resumeHost`

Those APIs should still optimistically update settings immediately and stamp a local `updatedAt` for UI/debug visibility.

### SyncService

`SyncService` owns cloud sync orchestration:

- On `onSignedIn()` after entitlement confirmation:
  - read cloud profile once;
  - apply newest envelope;
  - start write-through;
  - start realtime subscription.
- On local cache mutation:
  - enqueue one cloud write with a new `writeId`;
  - coalesce rapid local writes so only the latest settings are sent after the in-flight write completes.
- On write success:
  - apply returned server envelope;
  - mark `cloudReachable = true`.
- On write failure:
  - keep the local optimistic value;
  - mark `cloudReachable = false`;
  - retry the latest local value on next edit/resume/reconnect.
- On realtime event:
  - apply the envelope if newer;
  - if applied, update local host storage and notify UI/extension listeners.
- On realtime disconnect/reconnect:
  - mark realtime stale;
  - run `readProfile()` on reconnect;
  - restart subscription if needed.
- On sign-out/delete/account switch:
  - stop write-through;
  - unsubscribe realtime;
  - clear identity-bound sync metadata.

### Same-surface event propagation

Every host must bridge `SettingsCache` notifications to the local extension runtime:

- Apple app writes the App Group settings+metadata record after every local or remote apply.
- Safari extension reads the App Group settings+metadata record during activation and content-script startup.
- Safari extension must also refresh from App Group on page visibility/focus and at a bounded interval while a supported site is open if no native push mechanism exists.
- Chrome/Firefox writes settings+metadata to extension storage; popup/options/content scripts listen to storage changes.
- Content scripts must re-run the rule engine after settings changes. The re-run must be debounced to avoid DOM thrash.

## Implementation Units

### U1. Database migration and RPC

Files:

- `supabase/migrations/0009_profile_settings_server_clock.sql`
- `supabase/tests/rls_test.sql`

Tasks:

- Add profile metadata columns.
- Add `write_profile_settings(jsonb, uuid)` RPC.
- Grant execute to `authenticated`.
- Add profiles table to Supabase Realtime publication.
- Revoke direct profile write grants after the client RPC path is implemented.
- Extend pgTAP tests.

Required tests:

- Entitled user can call `write_profile_settings` for own profile.
- Un-entitled user cannot call `write_profile_settings`.
- Authenticated user cannot pass another user id because the RPC has no user id parameter.
- Anonymous user cannot call the RPC.
- Direct profile insert/update by authenticated user is denied after the migration.
- Two accepted writes increment `settings_version` from 1 to 2.
- `settings_server_updated_at` changes on each accepted write.
- Invalid non-object settings JSON is rejected.

### U2. Core synced envelope model

Files:

- `packages/core/src/sync/ports.ts`
- `packages/core/src/sync/profile.ts`
- `packages/core/src/storage/cache.ts`
- relevant core tests under `packages/core/src/**/__tests__`

Tasks:

- Add envelope and metadata types.
- Update `SupabaseBackendPort.readProfile()`.
- Update `SupabaseBackendPort.writeProfile()` to call the RPC.
- Add `subscribeToProfile()`.
- Add `SettingsCache.applySyncedEnvelope()`.
- Store local settings metadata in host adapters.

Required tests:

- Higher version applies.
- Lower version is ignored.
- Equal version does not notify twice.
- Server write response replaces local metadata.
- Invalid envelope is ignored safely.
- Existing local settings APIs still notify and persist.

### U3. SyncService realtime orchestration

Files:

- `packages/core/src/sync/service.ts`
- `packages/core/src/sync/__tests__/sync.test.ts`

Tasks:

- Start realtime after entitlement confirmation.
- Stop realtime on teardown.
- Apply realtime envelopes.
- Coalesce local writes and protect against stale write acknowledgements.
- Add reconnect read-through.

Required tests:

- Local edit writes through RPC and applies returned version.
- Remote realtime update with higher version updates local settings.
- Remote lower version is ignored.
- Remote higher version arriving during an in-flight local write wins.
- Failed write sets `cloudReachable = false` and does not discard local optimistic settings.
- Reconnect calls `readProfile()` before accepting future events as current.
- Sign-out unsubscribes realtime and stops write-through.

### U4. Apple App Group metadata and Safari refresh

Files:

- `apps/apple/StillKit/Sources/StillKit/SharedSettingsStore.swift`
- `apps/apple/StillKit/Sources/StillKit/SettingsBridge.swift`
- `apps/apple/Still/Shared (Extension)/SafariWebExtensionHandler.swift`
- Apple bridge tests
- Safari extension storage adapter files

Tasks:

- Extend App Group stored record to include settings metadata.
- Keep backward compatibility with old settings-only records.
- Ensure WKWebView writes and reads settings+metadata.
- Ensure Safari extension pulls settings+metadata on activation/startup.
- Add same-device refresh path for active Safari pages.

Required tests:

- Old settings-only App Group record still decodes.
- New settings+metadata record decodes and round-trips.
- Stale incoming App Group write is ignored by version.
- Newer App Group write updates the web cache.
- Safari extension startup applies App Group metadata before running rules.

### U5. Chrome and Firefox storage propagation

Files:

- `packages/ext-chromium/**`
- `packages/core/src/storage/**`
- Firefox build/test config as needed

Tasks:

- Persist settings metadata with settings in extension storage.
- Subscribe popup/options/content scripts to storage changes.
- Re-run rule application on supported pages after settings changes.
- Ensure MV3 worker wake/resume rehydrates metadata before writing.

Required tests:

- Storage change with higher version updates UI state.
- Storage change with lower version is ignored.
- Content script receives/reloads settings without popup reopen.
- Firefox build uses the same storage metadata path.

### U6. Cross-surface integration tests

Tests may use fakes/mocks rather than live Supabase where appropriate.

Required scenarios:

- iOS-like Apple app writes setting A. macOS-like app receives realtime event and updates to A.
- Chrome extension writes setting B. Apple app receives realtime event and updates to B.
- Firefox extension writes setting C. Chrome extension receives realtime event and updates to C.
- Two surfaces write conflicting settings. The RPC accepted second has the higher version and wins everywhere.
- A device with an incorrect future clock cannot permanently win by sending a larger `settings.updatedAt`.
- Free signed-in user cannot write settings.
- Signed-out user cannot subscribe or write.

## Manual Release Validation

Use the entitled account `zack+sandbox2@cadmuslabs.co`.

### iOS to macOS

1. Sign in on iOS and macOS.
2. On iOS, turn a Pro service off.
3. Within 2 seconds, macOS app should show the same service off.
4. Safari on macOS should enforce the new setting without reopening Still.
5. Turn the service back on from macOS.
6. iOS should match without manual restore or relaunch.

### macOS to Chrome

1. Sign in on macOS and Chrome extension.
2. Toggle global Still off on macOS.
3. Chrome popup/options should show off within 2 seconds.
4. A supported open page should stop enforcing after the extension refresh path runs.
5. Toggle global Still on from Chrome.
6. macOS should match within 2 seconds.

### Conflict

1. Open two signed-in surfaces.
2. Toggle the same service differently within 1 second.
3. Query `public.profiles.settings_version`.
4. Confirm every surface converges to the state from the higher server version.

### Offline

1. Disable network on one surface.
2. Change settings locally.
3. Confirm local UI updates and cloud status indicates sync is not reachable.
4. Change settings on an online surface.
5. Re-enable network.
6. Confirm the server-latest version wins and both surfaces converge.

## Verification Commands

Run at minimum:

```bash
supabase test db
pnpm --filter @still/core typecheck
pnpm --filter @still/core test
pnpm --filter @still/app-webview typecheck
pnpm --filter @still/ext-safari test
pnpm --filter @still/ext-safari build
pnpm --filter @still/ext-chromium test
pnpm --filter @still/ext-chromium build
pnpm --filter @still/ext-chromium build:firefox
apps/apple/scripts/build.sh ios-sim
apps/apple/scripts/build.sh macos
```

Correction: `apps/apple/scripts/build.sh ios` is not a valid target in this repository; the script
accepts `ios-sim`, `ios-device`, or `macos`. Local PR verification uses `ios-sim` as the unsigned iOS
build equivalent.

If any command does not exist, update this spec with the repository's actual command before implementation is considered complete.

## Acceptance Criteria

- Server version and server timestamp exist on `public.profiles`.
- All profile writes use `write_profile_settings`.
- Direct client profile insert/update is denied.
- Active entitled surfaces subscribe to profile row updates.
- Active surfaces converge within 2 seconds p95 and 5 seconds worst-case in manual validation.
- Latest server-accepted write wins across all surfaces.
- Device clock skew cannot determine the cloud winner.
- Free users cannot write synced settings.
- Sign-out/account switch stops realtime and cannot leak settings between users.
- Already-open supported pages receive setting changes through storage/native refresh and re-run rule application.
- Documentation and release matrix are updated with validation results.

## Open Implementation Notes

- If Supabase Realtime is unavailable in an extension worker on a target browser, implement a bounded fallback poll of `readProfile()` every 2 seconds while the popup/options is open and every 15 seconds while a supported content page is active. This is a fallback only; Realtime is the default path.
- If iOS Safari does not provide reliable app-to-extension push, active content scripts should refresh from App Group or extension storage on `visibilitychange`, `pageshow`, focus, and a short bounded interval while on supported domains.
- Realtime subscriptions must be conservative with battery: subscribe only while the app, extension UI, background worker, or supported content pages are active.
