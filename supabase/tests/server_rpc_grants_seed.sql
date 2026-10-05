-- TEST ONLY. Synthetic, disposable data for server_rpc_grants_test.ts. Run as the ordinary
-- `postgres` login against a throwaway local or CI database, never a hosted project.
--
-- Upgrade path: apply after `supabase db reset --version 0013` and before 0014, so the test can
-- prove 0014 leaves every row byte-for-byte unchanged. Clean path: the test runs it itself after
-- all migrations. The rows mirror the shapes production holds: a historical paid entitlement, a
-- free-era account, an account with no rows, completed/processing/legacy purchase events, live
-- rate-limit windows and canary state.
begin;

insert into auth.users (id, email) values
  ('a1a1a1a1-0000-4000-8000-000000000001', 'u1a-paid@example.invalid'),
  ('b2b2b2b2-0000-4000-8000-000000000002', 'u1a-free@example.invalid'),
  ('c3c3c3c3-0000-4000-8000-000000000003', 'u1a-empty@example.invalid');

-- Historical purchase record and a free-era account written through the server RPC.
select public.set_entitlement('a1a1a1a1-0000-4000-8000-000000000001', true, 'revenuecat', 'synthetic-sub-a');
select public.set_entitlement('b2b2b2b2-0000-4000-8000-000000000002', false, 'reconcile', null);

insert into public.profiles (id, settings, settings_version, settings_last_write_id) values
  ('a1a1a1a1-0000-4000-8000-000000000001', '{"globalOn":true,"services":{"youtube":true}}', 3,
   'aaaaaaaa-0000-4000-8000-00000000000a'),
  ('b2b2b2b2-0000-4000-8000-000000000002', '{"globalOn":false}', 1,
   'bbbbbbbb-0000-4000-8000-00000000000b');

-- Purchase-event log: completed, in-flight and legacy record-after rows.
do $$
declare
  token uuid;
begin
  select claim_token into token from public.claim_revenuecat_event(
    'u1a-evt-completed', 'a1a1a1a1-0000-4000-8000-000000000001', '{"type":"INITIAL_PURCHASE"}');
  perform public.complete_revenuecat_event('u1a-evt-completed', token);
  perform public.claim_revenuecat_event(
    'u1a-evt-processing', 'a1a1a1a1-0000-4000-8000-000000000001', '{"type":"RENEWAL"}');
  perform public.record_revenuecat_event(
    'u1a-evt-legacy', 'a1a1a1a1-0000-4000-8000-000000000001', '{"type":"TRANSFER"}');
end
$$;

-- Live 600-second windows so the counters outlive the test run.
select public.consume_rate_limit('reconcile:user:a1a1a1a1-0000-4000-8000-000000000001', 10, 600);
select public.consume_rate_limit('checkout:ip:203.0.113.7', 20, 600);

insert into public.canary_state (key, num, flag) values ('svc:youtube', 2, false), ('surf:yt:shelf', 0, true);

-- One fingerprint definition shared by the seed and the test, kept out of the client schema.
create schema u1a_fixture;
revoke all on schema u1a_fixture from public;
create view u1a_fixture.fingerprints as
  select 'auth.users' as name, md5(coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email)
    order by u.id)::text, '')) as digest
    from auth.users u where u.email like 'u1a-%@example.invalid'
  union all select 'entitlements', md5(coalesce(jsonb_agg(to_jsonb(e) order by e.user_id)::text, ''))
    from public.entitlements e
  union all select 'profiles', md5(coalesce(jsonb_agg(to_jsonb(p) order by p.id)::text, ''))
    from public.profiles p
  union all select 'revenuecat_events', md5(coalesce(jsonb_agg(to_jsonb(r) order by r.event_id)::text, ''))
    from public.revenuecat_events r
  union all select 'rule_sets', md5(coalesce(jsonb_agg(to_jsonb(s) order by s.version)::text, ''))
    from public.rule_sets s
  union all select 'canary_state', md5(coalesce(jsonb_agg(to_jsonb(c) order by c.key)::text, ''))
    from public.canary_state c
  -- Counters expire by design; compare the windows that are still live at both moments.
  union all select 'rate_limit_counters', md5(coalesce(jsonb_agg(to_jsonb(k) order by k.bucket_key,
    k.window_start)::text, '')) from public.rate_limit_counters k where k.window_seconds = 600;
create table u1a_fixture.baseline as select name, digest from u1a_fixture.fingerprints;
create table u1a_fixture.row_counts as
  select (select count(*)::int from public.entitlements) as entitlements,
         (select count(*)::int from public.profiles) as profiles,
         (select count(*)::int from public.revenuecat_events) as revenuecat_events,
         (select count(*)::int from public.rate_limit_counters) as rate_limit_counters,
         (select count(*)::int from public.canary_state) as canary_state;
-- Privileges as they stand when the seed runs. On the upgrade path that is the 0013 state, which
-- lets the test show the hole existed and is closed by the migration on the same database.
create table u1a_fixture.pre_privileges as
  select r.rolname, f.sig, has_function_privilege(r.rolname, f.sig, 'EXECUTE') as can_execute
  from (values ('anon'), ('authenticated'), ('service_role')) r(rolname),
       (values ('public.set_entitlement(uuid,boolean,text,text)'),
               ('public.record_revenuecat_event(text,text,jsonb)'),
               ('public.claim_revenuecat_event(text,text,jsonb)'),
               ('public.complete_revenuecat_event(text,uuid)'),
               ('public.release_revenuecat_event(text,uuid)')) f(sig);
create table u1a_fixture.pre_table_writes as
  select r.rolname, t.relname,
    has_table_privilege(r.rolname, 'public.' || t.relname, 'INSERT,UPDATE,DELETE,TRUNCATE') as can_write
  from (values ('anon'), ('authenticated')) r(rolname),
       (values ('profiles'), ('entitlements'), ('revenuecat_events'), ('rule_sets'),
               ('rate_limit_counters'), ('rate_limit_window_keys'), ('canary_state')) t(relname);

commit;
