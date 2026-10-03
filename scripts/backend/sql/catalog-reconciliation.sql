-- UNNUMBERED synthetic input boundary. Populate only from explicitly reviewed reconciliation.
-- Empty input never grants a provider exemption. These tables are owner-only, not audit output.
create schema if not exists still_security;
revoke all on schema still_security from public, anon, authenticated, service_role, still_entitlement_writer;
create table if not exists still_security.reconciled_creators (role_name text primary key);
create table if not exists still_security.approved_provider_routines (
  routine text primary key,
  descriptor jsonb not null
);
revoke all on all tables in schema still_security from public, anon, authenticated, service_role, still_entitlement_writer;

-- Returns a complete descriptor for comparison inside the owner-owned audit. No client/auditor
-- gets this raw metadata. Body text is compared exactly, not exempted by a name or live baseline.
create or replace function still_security.provider_descriptor(routine_oid oid) returns jsonb
language sql stable set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'schema', n.nspname,
    'routine', p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
    'owner', pg_catalog.pg_get_userbyid(p.proowner),
    'return_type', pg_catalog.pg_get_function_result(p.oid),
    'language', l.lanname,
    'configuration', p.proconfig,
    'security_definer', p.prosecdef,
    'body', p.prosrc,
    'bindings', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'name', e.evtname, 'owner', pg_catalog.pg_get_userbyid(e.evtowner),
        'event', e.evtevent, 'enabled', e.evtenabled::text,
        'tags', (select pg_catalog.jsonb_agg(tag order by tag) from pg_catalog.unnest(e.evttags) tag)
      ) order by e.evtname) from pg_catalog.pg_event_trigger e where e.evtfoid = p.oid
    ), '[]'::jsonb)
  ) from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_language l on l.oid = p.prolang
  where p.oid = routine_oid;
$$;
revoke all on function still_security.provider_descriptor(oid) from public, anon, authenticated, service_role, still_entitlement_writer;
