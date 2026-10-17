-- Released apps' legacy settings save: refuse with a non-retryable error code.
--
-- What broke. Migration 0015 made the legacy RPC `public.write_profile_settings(jsonb, uuid)`
-- refuse a released-app write, for an account whose settings a newer client now owns, with
-- `raise exception 'settings client upgrade required' using errcode = '40001'`. Released 2.x apps
-- call this function through PostgREST. PostgREST treats SQLSTATE 40001 (serialization_failure)
-- and 40P01 (deadlock_detected) as transient and re-runs the whole transaction; the hosted
-- PostgREST version retries without a limit (fixed upstream in PostgREST 16). The guard is
-- deterministic, so one refused request becomes a server-side loop that never ends: each loop
-- holds a PostgREST pool connection and rolls back thousands of transactions a second, and the
-- exhausted pool then times out unrelated requests (PGRST003).
--
-- Rule for every later migration. Never raise 40001 or 40P01 for a business decision in any
-- function PostgREST can reach: anything executable by anon, authenticated or PUBLIC, and any
-- trigger on a table those roles can write. Those codes mean "run me again"; use a P0001-style
-- code, or a `PTxyz` code when a specific HTTP status is wanted. `deploy/deploy.test.mjs` refuses
-- a migration history in which such a function raises either code.
--
-- The change. Only the error code of the guard: `PT409`, which PostgREST answers with HTTP 409 and
-- never retries. The message stays `settings client upgrade required`, and the row is still left
-- untouched. The body is otherwise byte-identical to 0015's (same arguments, result columns,
-- SECURITY DEFINER, owner, `search_path = pg_catalog, pg_temp`), and the grants are restated as
-- 0015 restated them: signed-in users only. Released apps parse no error code and back off
-- exponentially (capped at 30 seconds) on any failed write, so the new code is safe for them.
--
-- Left unchanged on purpose. `private.commit_settings` also raises 40001 ('lineage changed',
-- 'canonical changed'), but only `still_settings_writer` may execute it, and the sync-settings
-- Edge Function calls it over its own direct PostgreSQL connection (postgres.js inside one
-- transaction), which never retries automatically. PostgREST cannot reach it.
--
-- After deploying. New transactions run the new body, so a loop that re-runs the function should
-- stop on its own. If PostgREST backends that started before the deploy keep rolling back, an
-- owner-approved step terminates those `authenticator` backends (see
-- docs/plans/2026-10-17-001-fix-legacy-settings-infinite-retry.md).
--
-- Authority and idempotence. Applied by the hosted migration role `postgres` (non-superuser) and
-- nothing else. It replaces the function only when its current body is the reviewed 0015 body or
-- this migration's own, so a second apply leaves the catalog as it was. No row is read or written.

-- ── 0. Preconditions: fail before any DDL ─────────────────────────────────────────────────────
do $$
declare
  legacy pg_catalog.pg_proc%rowtype;
begin
  if current_user <> 'postgres'
     or (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'legacy settings guard migration role precondition' using errcode = '42501';
  end if;
  select * into legacy from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure('public.write_profile_settings(jsonb,uuid)');
  if not found or not legacy.prosecdef
     or legacy.proowner is distinct from (
       select r.oid from pg_catalog.pg_roles r where r.rolname = 'postgres' and not r.rolsuper) then
    raise exception 'legacy settings owner precondition' using errcode = '42501';
  end if;
  -- The reviewed 0015 body, or this migration's own body on a re-run; never an unknown one.
  if pg_catalog.md5(legacy.prosrc) not in ('a77f3d44e9cd733e57d24aedcdebddfd',
                                           '4a0d205e2d0a57d4677a60c01c26c344') then
    raise exception 'legacy settings body precondition' using errcode = '55000';
  end if;
end
$$;

-- ── 1. Free settings sync: the 0015 body with a non-retryable guard code ───────────────────────
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
set search_path = pg_catalog, pg_temp
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

  if p_settings is null or pg_catalog.jsonb_typeof(p_settings) <> 'object' then
    raise exception 'settings must be a json object' using errcode = '22023';
  end if;

  -- ── 0015 guard ──
  -- Take the per-account lock the per-field writer path holds for its whole transaction, then
  -- decide. A per-field commit in flight therefore finishes first and this check sees it.
  perform 1 from auth.users u where u.id = v_user_id for no key update;
  if (p_settings ? 'schemaVersion' and p_settings -> 'schemaVersion' <> '1'::jsonb)
     or exists (select 1 from private.settings_anchors a
             where a.user_id = v_user_id and a.modern_used)
     or exists (select 1 from public.profiles p
                where p.id = v_user_id and p.settings ? 'schemaVersion'
                  and p.settings -> 'schemaVersion' <> '1'::jsonb) then
    raise exception 'settings client upgrade required' using errcode = 'PT409';
  end if;
  -- ── end 0015 guard ──

  v_server_time := pg_catalog.clock_timestamp();

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

-- Grants restated as in 0014 and 0015: signed-in users only.
revoke all on function public.write_profile_settings(jsonb, uuid) from public, anon, service_role;
grant execute on function public.write_profile_settings(jsonb, uuid) to authenticated;

-- ── 2. Self-check: abort the whole migration unless the final state is the intended one ───────
do $$
declare
  item record;
  issues text[] := '{}';
  owner_oid oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = 'postgres');
begin
  select p.proowner, p.prosecdef, p.proconfig, p.proacl, p.prosrc into item
  from pg_catalog.pg_proc p where p.oid = 'public.write_profile_settings(jsonb,uuid)'::regprocedure;
  if item.proowner <> owner_oid or not item.prosecdef
     or item.proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[] then
    issues := issues || 'free_sync_definition'::text;
  end if;
  if pg_catalog.md5(item.prosrc) <> '4a0d205e2d0a57d4677a60c01c26c344' then
    issues := issues || 'free_sync_body'::text;
  end if;
  if (select pg_catalog.array_agg(a.grantee::regrole::text || ':' || a.privilege_type || ':' || a.is_grantable::text)
      from pg_catalog.aclexplode(coalesce(item.proacl, pg_catalog.acldefault('f', item.proowner))) a
      where a.grantee <> item.proowner)
     is distinct from array['authenticated:EXECUTE:false'] then
    issues := issues || 'free_sync_grantees'::text;
  end if;
  if pg_catalog.cardinality(issues) > 0 then
    raise exception 'legacy settings guard self-check failed: %', pg_catalog.array_to_string(issues, ', ')
      using errcode = 'P0001';
  end if;
end
$$;
