-- TEST ONLY. Synthetic, disposable data for product_policy_migration_test.ts. Run as the ordinary
-- `postgres` login against a throwaway local or CI database, never a hosted project.
--
-- Upgrade path: apply after the database is at 0015 and before 0016, so the test can prove 0016
-- leaves every existing row byte-for-byte unchanged. Clean path: the test runs it itself after all
-- migrations. Besides its own released-app shaped accounts (a settings document, a historical
-- purchase, a per-field settings anchor), the fingerprints cover every row of the tables 0016 could
-- conceivably touch, including rows other rehearsal seeds left behind.
begin;

insert into auth.users (id, email) values
  ('e1e1e1e1-0000-4000-8000-000000000001', 'u6p-settings@example.invalid'),
  ('e2e2e2e2-0000-4000-8000-000000000002', 'u6p-paid@example.invalid'),
  ('e3e3e3e3-0000-4000-8000-000000000003', 'u6p-owner@example.invalid'),
  ('e4e4e4e4-0000-4000-8000-000000000004', 'u6p-second-owner@example.invalid'),
  ('e5e5e5e5-0000-4000-8000-000000000005', 'u6p-stranger@example.invalid');

-- The historical purchase stays a historical purchase; 0016 never reads it.
insert into public.entitlements (user_id, still_sync, source, revenuecat_subscriber_id, updated_at)
values ('e2e2e2e2-0000-4000-8000-000000000002', true, 'webhook', 'synthetic-sub-e2', '2026-09-10 09:00:00+00');

insert into public.profiles
  (id, settings, updated_at, settings_version, settings_server_updated_at, settings_last_write_id) values
  ('e1e1e1e1-0000-4000-8000-000000000001',
   '{"globalOn":true,"services":{"youtube":true,"instagram":false,"tiktok":true,"facebook":true},"pauses":[],"updatedAt":1790000000000}',
   '2026-09-21 12:00:00.123+00', 7, '2026-09-21 12:00:00.123+00', 'eeeeeeee-0000-4000-8000-0000000000e1');

-- A per-field settings anchor, as 0015's writer path leaves one.
insert into private.settings_anchors (user_id, lineage, secret, modern_used)
values ('e1e1e1e1-0000-4000-8000-000000000001', 'f1f1f1f1-0000-4000-8000-000000000001',
        decode(repeat('6c', 32), 'hex'), true);

create schema u6p_fixture;
revoke all on schema u6p_fixture from public;
create view u6p_fixture.fingerprints as
  select 'auth.users' as name, md5(coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email)
    order by u.id)::text, '')) as digest from auth.users u
  union all select 'profiles', md5(coalesce(jsonb_agg(to_jsonb(p) order by p.id)::text, ''))
    from public.profiles p
  union all select 'entitlements', md5(coalesce(jsonb_agg(to_jsonb(e) order by e.user_id)::text, ''))
    from public.entitlements e
  union all select 'revenuecat_events', md5(coalesce(jsonb_agg(to_jsonb(r) order by r.event_id)::text, ''))
    from public.revenuecat_events r
  union all select 'rule_sets', md5(coalesce(jsonb_agg(to_jsonb(s) order by s.version)::text, ''))
    from public.rule_sets s
  union all select 'canary_state', md5(coalesce(jsonb_agg(to_jsonb(c)::text order by to_jsonb(c)::text)::text, ''))
    from public.canary_state c
  union all select 'settings_anchors', md5(coalesce(jsonb_agg(jsonb_build_object('user_id', a.user_id,
    'lineage', a.lineage, 'secret', encode(a.secret, 'hex'), 'modern_used', a.modern_used)
    order by a.user_id)::text, '')) from private.settings_anchors a
  union all select 'settings_writes', md5(coalesce(jsonb_agg(to_jsonb(w) order by w.user_id, w.write_id)::text, ''))
    from private.settings_writes w;
create table u6p_fixture.baseline as select name, digest from u6p_fixture.fingerprints;
-- Whether the policy objects existed when the seed ran: absent on the upgrade path.
create table u6p_fixture.pre_state as
  select pg_catalog.to_regclass('private.product_policy_revisions') is not null as policy_tables,
         exists (select 1 from pg_catalog.pg_roles where rolname = 'still_policy_admin') as policy_roles;

commit;
