-- Sync is a paid feature. Reads remain owner-scoped, but profile writes require the caller to own
-- the row AND have an active still_sync entitlement. This prevents an un-entitled signed-in user from
-- scripting the Supabase REST API to use paid cross-device sync.

drop policy if exists "profiles: insert own" on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;

create policy "profiles: insert own entitled"
  on public.profiles for insert
  to authenticated
  with check (
    (select auth.uid()) = id
    and exists (
      select 1
      from public.entitlements e
      where e.user_id = id
        and e.still_sync = true
    )
  );

create policy "profiles: update own entitled"
  on public.profiles for update
  to authenticated
  using (
    (select auth.uid()) = id
    and exists (
      select 1
      from public.entitlements e
      where e.user_id = id
        and e.still_sync = true
    )
  )
  with check (
    (select auth.uid()) = id
    and exists (
      select 1
      from public.entitlements e
      where e.user_id = id
        and e.still_sync = true
    )
  );
