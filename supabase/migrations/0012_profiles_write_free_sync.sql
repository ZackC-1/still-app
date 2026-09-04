-- Cross-device settings sync no longer requires a purchase, so the one settings write path stops
-- asking whether the account owns anything. write_profile_settings still derives the subject from
-- auth.uid(), still refuses an anonymous caller, still validates its arguments, and is still the
-- only way an authenticated client can write public.profiles: direct insert and update grants stay
-- revoked (migration 0009) and the row-level read policy is unchanged. The only thing removed is
-- the still_sync entitlement check, which used to raise 42501 for a signed-in account with no
-- purchase.
--
-- Everything else in this function is a verbatim copy of the 0009 body. Keep it that way: the
-- reverse below is a literal restore, and a body that has drifted cannot be restored literally.

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
  v_server_time timestamptz;
begin
  if v_user_id is null then
    raise exception 'auth required' using errcode = '28000';
  end if;

  if p_write_id is null then
    raise exception 'write id required' using errcode = '22023';
  end if;

  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'settings must be a json object' using errcode = '22023';
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

-- The grants are unchanged by this migration and are restated so the function's reachability is
-- readable in one place: no one but a signed-in user may execute it.
revoke execute on function public.write_profile_settings(jsonb, uuid) from public;
grant execute on function public.write_profile_settings(jsonb, uuid) to authenticated;

-- ── REVERSE (manual) ─────────────────────────────────────────────────────────────
-- Making sync a paid feature again means restoring the entitlement check. Apply the following as a
-- new forward migration rather than editing this file, so the history stays honest. This is the
-- exact 0009 body: it differs from the function above only by the v_entitled declaration, the
-- select into it, and the raise.
--
--   create or replace function public.write_profile_settings(
--     p_settings jsonb,
--     p_write_id uuid
--   ) returns table (
--     settings jsonb,
--     settings_version bigint,
--     settings_server_updated_at timestamptz,
--     settings_last_write_id uuid
--   )
--   language plpgsql
--   security definer
--   set search_path = public
--   as $$
--   declare
--     v_user_id uuid := (select auth.uid());
--     v_entitled boolean;
--     v_server_time timestamptz;
--   begin
--     if v_user_id is null then
--       raise exception 'auth required' using errcode = '28000';
--     end if;
--
--     if p_write_id is null then
--       raise exception 'write id required' using errcode = '22023';
--     end if;
--
--     if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
--       raise exception 'settings must be a json object' using errcode = '22023';
--     end if;
--
--     select e.still_sync into v_entitled
--     from public.entitlements e
--     where e.user_id = v_user_id;
--
--     if coalesce(v_entitled, false) is not true then
--       raise exception 'still_sync entitlement required' using errcode = '42501';
--     end if;
--
--     v_server_time := clock_timestamp();
--
--     insert into public.profiles (
--       id,
--       settings,
--       updated_at,
--       settings_version,
--       settings_server_updated_at,
--       settings_last_write_id
--     )
--     values (
--       v_user_id,
--       p_settings,
--       v_server_time,
--       1,
--       v_server_time,
--       p_write_id
--     )
--     on conflict (id) do update
--       set settings = excluded.settings,
--           updated_at = v_server_time,
--           settings_version = public.profiles.settings_version + 1,
--           settings_server_updated_at = v_server_time,
--           settings_last_write_id = excluded.settings_last_write_id;
--
--     return query
--       select p.settings,
--              p.settings_version,
--              p.settings_server_updated_at,
--              p.settings_last_write_id
--       from public.profiles p
--       where p.id = v_user_id;
--   end;
--   $$;
--
--   revoke execute on function public.write_profile_settings(jsonb, uuid) from public;
--   grant execute on function public.write_profile_settings(jsonb, uuid) to authenticated;
--
-- Restoring the check leaves every profile written during the free era in place. It only stops
-- further writes from accounts without the entitlement, which is what the paid rule meant.
