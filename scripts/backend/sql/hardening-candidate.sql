-- UNNUMBERED, synthetic rehearsal only. Actual creator-role/migration inventory and exact owner
-- review must precede assigning a migration. Does not alter settings, entitlements or event data.
-- Execute in one transaction with security-audit-candidate.sql and assert-security.sql.
revoke create on schema public from public, anon, authenticated;

do $$ declare signature text; table_name text; column_name text; creator text; begin
  foreach signature in array array[
    'public.set_entitlement(uuid,boolean,text,text)',
    'public.record_revenuecat_event(text,text,jsonb)',
    'public.claim_revenuecat_event(text,text,jsonb)',
    'public.complete_revenuecat_event(text,uuid)',
    'public.release_revenuecat_event(text,uuid)',
    'public.consume_rate_limit(text,integer,integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', signature);
    execute format('grant execute on function %s to still_entitlement_writer', signature);
    execute format('alter function %s set search_path = %L', signature, '');
  end loop;
  -- Trigger/cleanup helpers stay owner-only, and free settings sync stays authenticated-only.
  revoke all on function public.cleanup_rate_limit_counters(), public.sync_rate_limit_account()
    from public, anon, authenticated, still_entitlement_writer;
  revoke all on function public.write_profile_settings(jsonb,uuid) from public, anon;
  grant execute on function public.write_profile_settings(jsonb,uuid) to authenticated;
  alter function public.write_profile_settings(jsonb,uuid) set search_path = '';

  foreach table_name in array array[
    'profiles', 'entitlements', 'revenuecat_events', 'rule_sets', 'rate_limit_counters', 'rate_limit_window_keys'
  ] loop
    execute format('revoke all on table public.%I from public, anon, authenticated, still_entitlement_writer', table_name);
    for column_name in select a.attname from pg_attribute a
      where a.attrelid = format('public.%I', table_name)::regclass and a.attnum > 0 and not a.attisdropped
    loop
      execute format('revoke all (%I) on table public.%I from public, anon, authenticated, still_entitlement_writer', column_name, table_name);
    end loop;
  end loop;
  -- Owners are observable in catalogs; actual deployment creators must be reconciled by the owner.
  -- No assumption that an owner equals every historical/current creator is made here.
  for creator in
    select distinct r.rolname from pg_roles r where r.oid in (
      select p.proowner from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
      union select c.relowner from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
      union select oid from pg_roles where rolname = current_user)
  loop
    -- PUBLIC's implicit global function default must be removed globally; schema-specific direct
    -- ACL entries are ADDITIVE, so revoke those too. Table/sequence global ACLs also need review.
    execute format('alter default privileges for role %I revoke execute on functions from public, anon, authenticated', creator);
    execute format('alter default privileges for role %I in schema public revoke execute on functions from public, anon, authenticated', creator);
    execute format('alter default privileges for role %I revoke all on tables from public, anon, authenticated', creator);
    execute format('alter default privileges for role %I in schema public revoke all on tables from public, anon, authenticated', creator);
    execute format('alter default privileges for role %I revoke all on sequences from public, anon, authenticated', creator);
    execute format('alter default privileges for role %I in schema public revoke all on sequences from public, anon, authenticated', creator);
  end loop;
end $$;
grant select on public.profiles to authenticated;
grant select (user_id, still_sync) on public.entitlements to authenticated;
-- These read grants preserve the existing zero-row RLS response, not raw event/rule enumeration.
grant select on public.revenuecat_events, public.rule_sets to anon, authenticated;

-- Qualify the sole original unqualified table reference before pinning an empty search_path.
create or replace function public.get_current_rule_set()
returns table (version text, payload jsonb, signature jsonb)
language sql security definer set search_path = '' stable
as $$ select r.version, r.payload, r.signature from public.rule_sets r where r.is_current = true limit 1; $$;
revoke all on function public.get_current_rule_set() from public;
grant execute on function public.get_current_rule_set() to anon, authenticated;
