-- Close client reachability of the server-only purchase RPCs and restore the table privileges the
-- earlier migrations intended.
--
-- Why this is needed. Hosted Supabase installs default privileges for the creator role `postgres`
-- in schema public that grant EXECUTE on every new function, and all privileges on every new
-- table, directly to anon, authenticated and service_role. The earlier migrations only revoked
-- from PUBLIC, which does not remove those direct grants. As a result the PostgREST roles that the
-- public anon key reaches can execute set_entitlement and the RevenueCat event-log RPCs, and hold
-- far broader table privileges than 0002/0005/0007/0009 intended (RLS was the only barrier).
--
-- Authority boundary. Every statement here needs only what the hosted migration role `postgres`
-- has: it owns every object touched, it granted every privilege revoked, and it may alter its own
-- default privileges. Nothing targets supabase_admin-owned default privileges, which `postgres`
-- cannot change. Those remain a documented residual: an object that supabase_admin creates in
-- public would still arrive client-reachable. The self-check at the end deliberately does not
-- inspect them, and must fail on anything that is reachable now.
--
-- Unchanged on purpose: free settings sync (0012 body), rule-set reads, the rate-limit RPCs and
-- helpers (already closed by 0013), service_role table access used by export-user-data,
-- delete-user and selector-canary, and every data row. The statements are idempotent, so applying
-- this file twice yields the same catalog.

-- ── 1. Purchase RPCs: caller guard + empty search_path ─────────────────────────────────────────
-- Each body below is the earlier body verbatim, preceded by one guard. Inside a SECURITY DEFINER
-- function current_user is the owner, so the guard admits exactly:
--   * a session that logged in as still_entitlement_writer (the narrow credential the
--     revenuecat-webhook and reconcile-entitlement functions use), and
--   * a session whose login role already holds the owner's privileges (the owner itself or a
--     superuser). Such a session can write these tables directly, so refusing it adds nothing.
-- PostgREST always logs in as `authenticator` and only switches role, so anon, authenticated and
-- service_role requests fail here with 42501 even if a later grant regresses.

create or replace function public.set_entitlement(
  p_user_id uuid,
  p_still_sync boolean,
  p_source text,
  p_revenuecat_subscriber_id text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user <> 'still_entitlement_writer'
     and not pg_catalog.pg_has_role(session_user, current_user, 'USAGE') then
    raise exception 'server role required' using errcode = '42501';
  end if;

  insert into public.entitlements (user_id, still_sync, source, revenuecat_subscriber_id, updated_at)
  values (p_user_id, p_still_sync, p_source, p_revenuecat_subscriber_id, now())
  on conflict (user_id) do update
    set still_sync = excluded.still_sync,
        source = excluded.source,
        revenuecat_subscriber_id = excluded.revenuecat_subscriber_id,
        updated_at = now();
end;
$$;

create or replace function public.record_revenuecat_event(
  p_event_id text,
  p_app_user_id text,
  p_payload jsonb
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted boolean;
begin
  if session_user <> 'still_entitlement_writer'
     and not pg_catalog.pg_has_role(session_user, current_user, 'USAGE') then
    raise exception 'server role required' using errcode = '42501';
  end if;

  insert into public.revenuecat_events (event_id, app_user_id, payload)
  values (p_event_id, p_app_user_id, p_payload)
  on conflict (event_id) do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

create or replace function public.claim_revenuecat_event(
  p_event_id text,
  p_app_user_id text,
  p_payload jsonb
) returns table (claim_status text, claim_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted integer;
  v_token uuid := gen_random_uuid();
  existing_status text;
begin
  if session_user <> 'still_entitlement_writer'
     and not pg_catalog.pg_has_role(session_user, current_user, 'USAGE') then
    raise exception 'server role required' using errcode = '42501';
  end if;

  insert into public.revenuecat_events (event_id, app_user_id, payload, status, claim_token, claimed_at)
  values (p_event_id, p_app_user_id, p_payload, 'processing', v_token, now())
  on conflict (event_id) do nothing;
  get diagnostics inserted = row_count;
  if inserted > 0 then
    return query select 'claimed'::text, v_token;
    return;
  end if;

  update public.revenuecat_events
     set claim_token = v_token, claimed_at = now()
   where event_id = p_event_id
     and status = 'processing'
     and claimed_at < now() - interval '15 minutes';
  if found then
    return query select 'claimed'::text, v_token;
    return;
  end if;

  select status into existing_status
    from public.revenuecat_events
   where event_id = p_event_id;
  if existing_status = 'completed' then
    return query select 'duplicate'::text, null::uuid;
    return;
  end if;
  return query select 'in_flight'::text, null::uuid;
end;
$$;

-- complete/release were LANGUAGE sql; the guard needs PL/pgSQL. The single statement is unchanged.
create or replace function public.complete_revenuecat_event(
  p_event_id text,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user <> 'still_entitlement_writer'
     and not pg_catalog.pg_has_role(session_user, current_user, 'USAGE') then
    raise exception 'server role required' using errcode = '42501';
  end if;

  update public.revenuecat_events
     set status = 'completed', processed_at = now()
   where event_id = p_event_id and status = 'processing' and claim_token = p_claim_token;
end;
$$;

create or replace function public.release_revenuecat_event(
  p_event_id text,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user <> 'still_entitlement_writer'
     and not pg_catalog.pg_has_role(session_user, current_user, 'USAGE') then
    raise exception 'server role required' using errcode = '42501';
  end if;

  delete from public.revenuecat_events
   where event_id = p_event_id and status = 'processing' and claim_token = p_claim_token;
end;
$$;

-- ── 2. Purchase RPC execution: the narrow writer only ─────────────────────────────────────────
-- Remove the direct default-privilege grants (anon, authenticated, service_role) and PUBLIC.
-- No function source uses service_role for these RPCs: pg-store.ts connects as the writer.
-- record_revenuecat_event stays granted to the writer until the deployed webhook revision is
-- confirmed to use claim/complete only (see 0011).
revoke all on function public.set_entitlement(uuid, boolean, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.record_revenuecat_event(text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_revenuecat_event(text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_revenuecat_event(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.release_revenuecat_event(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.set_entitlement(uuid, boolean, text, text) to still_entitlement_writer;
grant execute on function public.record_revenuecat_event(text, text, jsonb) to still_entitlement_writer;
grant execute on function public.claim_revenuecat_event(text, text, jsonb) to still_entitlement_writer;
grant execute on function public.complete_revenuecat_event(text, uuid) to still_entitlement_writer;
grant execute on function public.release_revenuecat_event(text, uuid) to still_entitlement_writer;

-- ── 3. Client RPCs: keep intended callers, pin search_path, bodies untouched ──────────────────
-- write_profile_settings keeps the exact 0012 body (free sync). Only signed-in users call it; it
-- derives the subject from auth.uid(), so anon and service_role have no use for it.
alter function public.write_profile_settings(jsonb, uuid) set search_path = '';
revoke all on function public.write_profile_settings(jsonb, uuid) from public, anon, service_role;
grant execute on function public.write_profile_settings(jsonb, uuid) to authenticated;

-- get_current_rule_set already qualifies its one table reference. Clients read rules with the anon
-- key; selector-canary reads them with the service-role key, so service_role keeps EXECUTE.
alter function public.get_current_rule_set() set search_path = '';
revoke all on function public.get_current_rule_set() from public;
grant execute on function public.get_current_rule_set() to anon, authenticated, service_role;

-- ── 4. Table privileges: exactly what 0002/0005/0007/0009/0013 intended ───────────────────────
-- Strip every table and column privilege from PUBLIC, the two client roles and the writer, then
-- re-grant only the reads clients use. service_role (bypassrls server key used by export-user-data
-- and selector-canary) is deliberately left unchanged.
do $$
declare
  table_name text;
  column_name text;
begin
  foreach table_name in array array[
    'profiles', 'entitlements', 'revenuecat_events', 'rule_sets',
    'rate_limit_counters', 'rate_limit_window_keys', 'canary_state'
  ] loop
    execute format(
      'revoke all on table public.%I from public, anon, authenticated, still_entitlement_writer',
      table_name);
    for column_name in
      select a.attname from pg_catalog.pg_attribute a
      where a.attrelid = format('public.%I', table_name)::regclass
        and a.attnum > 0 and not a.attisdropped
    loop
      execute format(
        'revoke all (%I) on table public.%I from public, anon, authenticated, still_entitlement_writer',
        column_name, table_name);
    end loop;
  end loop;
end
$$;
-- Own-row reads (RLS-scoped) for the signed-in client, including Realtime profile changes.
grant select on public.profiles to authenticated;
grant select (user_id, still_sync) on public.entitlements to authenticated;
-- 0002 kept these so a direct read returns zero rows under the using(false) policy rather than an
-- error. Read only; no write privilege of any kind.
grant select on public.revenuecat_events, public.rule_sets to anon, authenticated;

-- ── 5. Schema public: no client CREATE ────────────────────────────────────────────────────────
-- Hosted already has none (the schema is owned by pg_database_owner). Only revoke when a client
-- actually holds it, so this never depends on authority over a grant that does not exist.
do $$
begin
  if pg_catalog.has_schema_privilege('anon', 'public', 'CREATE')
     or pg_catalog.has_schema_privilege('authenticated', 'public', 'CREATE') then
    revoke create on schema public from public, anon, authenticated;
  end if;
end
$$;

-- ── 6. Future objects created by postgres ─────────────────────────────────────────────────────
-- Stop new functions being executable by everyone (PostgreSQL's implicit PUBLIC default), and stop
-- the Supabase-installed public-schema defaults handing new functions, tables and sequences to
-- the client roles. Future migrations must grant clients explicitly, as every migration here
-- already does. service_role defaults are left as they are.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;

-- ── 7. Self-check: abort the whole migration unless the final state is the intended one ───────
-- Client reach is the closure of anon and authenticated over every membership edge (inherit, SET
-- or ADMIN). Trigger and event-trigger functions are excluded from the RPC check because they
-- cannot be called directly; that covers Supabase's own rls_auto_enable() event trigger. The
-- supabase_admin default privileges are the one reviewed residual and are not inspected.
do $$
declare
  issues text[] := '{}';
  server_rpcs text[] := array[
    'public.set_entitlement(uuid,boolean,text,text)',
    'public.record_revenuecat_event(text,text,jsonb)',
    'public.claim_revenuecat_event(text,text,jsonb)',
    'public.complete_revenuecat_event(text,uuid)',
    'public.release_revenuecat_event(text,uuid)',
    'public.consume_rate_limit(text,integer,integer)'
  ];
  protected_tables text[] := array[
    'profiles', 'entitlements', 'revenuecat_events', 'rule_sets',
    'rate_limit_counters', 'rate_limit_window_keys', 'canary_state'
  ];
  write_privileges text := case when pg_catalog.current_setting('server_version_num')::int >= 170000
    then 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    else 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' end;
  signature text;
  item record;
begin
  create temporary table u1_client_roles on commit drop as
    with recursive reachable(oid) as (
      select r.oid from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated')
      union
      select m.roleid from pg_catalog.pg_auth_members m join reachable c on m.member = c.oid
    ) select r.oid, r.rolname::text as rolname
      from reachable x join pg_catalog.pg_roles r on r.oid = x.oid;

  -- Server RPCs: writer only.
  foreach signature in array server_rpcs loop
    if not pg_catalog.has_function_privilege('still_entitlement_writer', signature, 'EXECUTE') then
      issues := issues || ('writer_missing:' || signature);
    end if;
    if pg_catalog.has_function_privilege('service_role', signature, 'EXECUTE') then
      issues := issues || ('service_role_execute:' || signature);
    end if;
  end loop;

  -- No client-reachable SECURITY DEFINER in public except the two client RPCs.
  for item in
    select distinct c.rolname, p.oid::regprocedure::text as routine
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join u1_client_roles c
    where n.nspname = 'public' and p.prosecdef
      and p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype,
                               'pg_catalog.event_trigger'::pg_catalog.regtype)
      and p.oid not in ('public.write_profile_settings(jsonb,uuid)'::regprocedure,
                        'public.get_current_rule_set()'::regprocedure)
      and pg_catalog.has_function_privilege(c.oid, p.oid, 'EXECUTE')
  loop
    issues := issues || ('client_execute:' || item.rolname || ':' || item.routine);
  end loop;

  -- Client RPC reachability is exactly the intended one.
  if pg_catalog.has_function_privilege('anon', 'public.write_profile_settings(jsonb,uuid)', 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', 'public.write_profile_settings(jsonb,uuid)', 'EXECUTE') then
    issues := issues || 'write_profile_settings_beyond_authenticated'::text;
  end if;
  if not pg_catalog.has_function_privilege('authenticated', 'public.write_profile_settings(jsonb,uuid)', 'EXECUTE') then
    issues := issues || 'free_sync_missing'::text;
  end if;
  if not (pg_catalog.has_function_privilege('anon', 'public.get_current_rule_set()', 'EXECUTE')
      and pg_catalog.has_function_privilege('authenticated', 'public.get_current_rule_set()', 'EXECUTE')
      and pg_catalog.has_function_privilege('service_role', 'public.get_current_rule_set()', 'EXECUTE')) then
    issues := issues || 'rule_read_missing'::text;
  end if;

  -- Every application SECURITY DEFINER in public has an empty search_path.
  for item in
    select p.oid::regprocedure::text as routine
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
      and not coalesce(p.proconfig @> array['search_path=""']::text[], false)
  loop
    issues := issues || ('unpinned_search_path:' || item.routine);
  end loop;

  -- Tables: RLS on, no client write of any kind, only the intended client reads, nothing for the
  -- writer.
  foreach signature in array protected_tables loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c
            where c.oid = format('public.%I', signature)::regclass) then
      issues := issues || ('rls_disabled:' || signature);
    end if;
    if pg_catalog.has_table_privilege('still_entitlement_writer', format('public.%I', signature),
         'SELECT,' || write_privileges)
       or pg_catalog.has_any_column_privilege('still_entitlement_writer', format('public.%I', signature),
         'SELECT,INSERT,UPDATE,REFERENCES') then
      issues := issues || ('writer_table_privilege:' || signature);
    end if;
  end loop;
  for item in
    select c.rolname, t.relname::text as relname, a.attname::text as attname,
      pg_catalog.has_column_privilege(c.oid, t.oid, a.attnum, 'SELECT') as can_select,
      pg_catalog.has_column_privilege(c.oid, t.oid, a.attnum, 'INSERT,UPDATE,REFERENCES') as can_write,
      pg_catalog.has_table_privilege(c.oid, t.oid, write_privileges) as can_write_table
    from pg_catalog.pg_class t
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
    cross join u1_client_roles c
    where n.nspname = 'public' and t.relname = any (protected_tables)
  loop
    if item.can_write or item.can_write_table then
      issues := issues || ('client_write:' || item.rolname || ':' || item.relname);
    end if;
    if item.can_select and not (
         (item.relname = 'profiles' and item.rolname = 'authenticated')
      or (item.relname = 'entitlements' and item.rolname = 'authenticated'
          and item.attname in ('user_id', 'still_sync'))
      or (item.relname in ('revenuecat_events', 'rule_sets')
          and item.rolname in ('anon', 'authenticated'))) then
      issues := issues || ('client_read:' || item.rolname || ':' || item.relname || '.' || item.attname);
    end if;
  end loop;

  -- No client CREATE on schema public.
  if exists (select 1 from u1_client_roles c
             where pg_catalog.has_schema_privilege(c.oid, 'public', 'CREATE')) then
    issues := issues || 'client_schema_create'::text;
  end if;

  -- postgres-creator defaults: no implicit or explicit function EXECUTE for PUBLIC or clients, and
  -- no public-schema default of any kind for PUBLIC or clients.
  if exists (
    select 1 from pg_catalog.pg_roles o
    left join pg_catalog.pg_default_acl d
      on d.defaclrole = o.oid and d.defaclnamespace = 0 and d.defaclobjtype = 'f'
    cross join lateral pg_catalog.aclexplode(coalesce(d.defaclacl, pg_catalog.acldefault('f', o.oid))) a
    where o.rolname = 'postgres' and a.privilege_type = 'EXECUTE'
      and (a.grantee = 0 or a.grantee in (select oid from u1_client_roles))
  ) then
    issues := issues || 'postgres_global_function_default'::text;
  end if;
  if exists (
    select 1 from pg_catalog.pg_default_acl d
    join pg_catalog.pg_roles o on o.oid = d.defaclrole
    join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    where o.rolname = 'postgres' and n.nspname = 'public'
      and (a.grantee = 0 or a.grantee in (select oid from u1_client_roles))
  ) then
    issues := issues || 'postgres_public_schema_default'::text;
  end if;
  if exists (
    select 1 from pg_catalog.pg_default_acl d
    join pg_catalog.pg_roles o on o.oid = d.defaclrole
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    where o.rolname = 'postgres' and d.defaclnamespace = 0 and d.defaclobjtype in ('r', 'S')
      and (a.grantee = 0 or a.grantee in (select oid from u1_client_roles))
  ) then
    issues := issues || 'postgres_global_relation_default'::text;
  end if;

  if pg_catalog.cardinality(issues) > 0 then
    raise exception 'server RPC privilege self-check failed: %',
      pg_catalog.array_to_string(issues, ', ') using errcode = '42501';
  end if;
end
$$;

-- ── FIX-FORWARD (manual, never a re-grant) ─────────────────────────────────────────────────────
-- Do not restore any client grant removed above; that reopens the hole this migration closes.
-- If the caller guard ever refuses the legitimate writer (for example a connection path whose
-- login role is not still_entitlement_writer), ship a NEW forward migration that recreates the
-- affected function without its guard block and keeps `set search_path = ''`, the writer-only
-- grants and the revokes above. The REVOKEs remain the primary control; the guard is a second
-- layer. Payments stay disabled until the fix-forward is verified.
