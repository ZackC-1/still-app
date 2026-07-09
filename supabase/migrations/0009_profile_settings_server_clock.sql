-- Server-authoritative settings ordering. Clients write settings only through
-- write_profile_settings(), which derives the subject from auth.uid(), checks the still_sync
-- entitlement, increments a database version, and stamps database time.

alter table public.profiles
  add column if not exists settings_version bigint not null default 0,
  add column if not exists settings_server_updated_at timestamptz not null default now(),
  add column if not exists settings_last_write_id uuid;

update public.profiles
set settings_server_updated_at = coalesce(updated_at, now())
where settings_server_updated_at is null;

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

  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
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

revoke execute on function public.write_profile_settings(jsonb, uuid) from public;
grant execute on function public.write_profile_settings(jsonb, uuid) to authenticated;

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

revoke insert, update on public.profiles from authenticated;
drop policy if exists "profiles: insert own entitled" on public.profiles;
drop policy if exists "profiles: update own entitled" on public.profiles;
