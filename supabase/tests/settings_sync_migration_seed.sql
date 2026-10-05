-- TEST ONLY. Synthetic, disposable data for settings_sync_migration_test.ts. Run as the ordinary
-- `postgres` login against a throwaway local or CI database, never a hosted project.
--
-- Upgrade path: apply after `supabase db reset --version 0014` and before 0015, so the test can
-- prove 0015 leaves every row byte-for-byte unchanged and that released apps keep syncing the
-- accounts they already use. Clean path: the test runs it itself after all migrations. The rows
-- mirror the settings shapes released apps have written through free sync (0012): a current
-- 2.x document, an older document without pauses, a minimal early document, a historical paid
-- account, and an account that has never saved settings.
begin;

insert into auth.users (id, email) values
  ('d1d1d1d1-0000-4000-8000-000000000001', 'u3m-current@example.invalid'),
  ('d2d2d2d2-0000-4000-8000-000000000002', 'u3m-older@example.invalid'),
  ('d3d3d3d3-0000-4000-8000-000000000003', 'u3m-minimal@example.invalid'),
  ('d4d4d4d4-0000-4000-8000-000000000004', 'u3m-paid@example.invalid'),
  ('d5d5d5d5-0000-4000-8000-000000000005', 'u3m-empty@example.invalid');

-- The historical purchase stays a historical purchase; 0015 never reads it.
select public.set_entitlement('d4d4d4d4-0000-4000-8000-000000000004', true, 'revenuecat', 'synthetic-sub-d4');

insert into public.profiles
  (id, settings, updated_at, settings_version, settings_server_updated_at, settings_last_write_id) values
  ('d1d1d1d1-0000-4000-8000-000000000001',
   '{"globalOn":true,"services":{"youtube":true,"instagram":false,"tiktok":true,"facebook":true},"pauses":[],"updatedAt":1790000000000}',
   '2026-09-21 12:00:00.123+00', 7, '2026-09-21 12:00:00.123+00', 'eeeeeeee-0000-4000-8000-00000000000a'),
  ('d2d2d2d2-0000-4000-8000-000000000002',
   '{"globalOn":false,"services":{"youtube":true,"instagram":true,"tiktok":false,"facebook":true},"updatedAt":1783000000000}',
   '2026-07-02 08:30:00+00', 2, '2026-07-02 08:30:00+00', 'eeeeeeee-0000-4000-8000-00000000000b'),
  ('d3d3d3d3-0000-4000-8000-000000000003', '{"globalOn":true}',
   '2026-06-01 00:00:00+00', 1, '2026-06-01 00:00:00+00', 'eeeeeeee-0000-4000-8000-00000000000c'),
  ('d4d4d4d4-0000-4000-8000-000000000004',
   '{"globalOn":true,"services":{"youtube":true,"instagram":true,"tiktok":true,"facebook":true},"pauses":[],"updatedAt":1789000000000}',
   '2026-09-10 09:00:00+00', 12, '2026-09-10 09:00:00+00', 'eeeeeeee-0000-4000-8000-00000000000d');

-- Rate-limit state in a fixed 2099 window, so the comparison is not racing the pg_cron cleanup.
insert into public.rate_limit_window_keys (window_start, window_seconds, secret, expires_at) values
  ('2099-02-01 00:00:00+00', 600, decode(repeat('3c', 32), 'hex'), '2099-02-01 00:10:00+00');
insert into public.rate_limit_counters
  (bucket_key, window_start, window_seconds, expires_at, account_id, count) values
  ('reconcile:user:' || repeat('d4', 32), '2099-02-01 00:00:00+00', 600, '2099-02-01 00:10:00+00',
   'd4d4d4d4-0000-4000-8000-000000000004', 2);

-- One fingerprint definition shared by the seed and the test, kept out of the client schema.
create schema u3m_fixture;
revoke all on schema u3m_fixture from public;
create view u3m_fixture.fingerprints as
  select 'auth.users' as name, md5(coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email)
    order by u.id)::text, '')) as digest
    from auth.users u where u.email like 'u3m-%@example.invalid'
  union all select 'profiles', md5(coalesce(jsonb_agg(to_jsonb(p) order by p.id)::text, ''))
    from public.profiles p where p.id in (select id from auth.users where email like 'u3m-%@example.invalid')
  union all select 'entitlements', md5(coalesce(jsonb_agg(to_jsonb(e) order by e.user_id)::text, ''))
    from public.entitlements e where e.user_id in (select id from auth.users where email like 'u3m-%@example.invalid')
  union all select 'rule_sets', md5(coalesce(jsonb_agg(to_jsonb(s) order by s.version)::text, ''))
    from public.rule_sets s
  union all select 'rate_limit_counters', md5(coalesce(jsonb_agg(to_jsonb(k) order by k.bucket_key,
    k.window_start)::text, '')) from public.rate_limit_counters k
    where k.window_start = '2099-02-01 00:00:00+00'
  union all select 'rate_limit_window_keys', md5(coalesce(jsonb_agg(to_jsonb(w) order by w.window_start,
    w.window_seconds)::text, '')) from public.rate_limit_window_keys w
    where w.window_start = '2099-02-01 00:00:00+00';
create table u3m_fixture.baseline as select name, digest from u3m_fixture.fingerprints;
create table u3m_fixture.row_counts as
  select (select count(*)::int from public.profiles
           where id in (select id from auth.users where email like 'u3m-%@example.invalid')) as profiles,
         (select count(*)::int from public.entitlements
           where user_id in (select id from auth.users where email like 'u3m-%@example.invalid')) as entitlements,
         (select count(*)::int from public.rate_limit_counters
           where window_start = '2099-02-01 00:00:00+00') as rate_limit_counters;
-- Whether the per-field objects existed when the seed ran: absent on the upgrade path.
create table u3m_fixture.pre_state as
  select pg_catalog.to_regnamespace('private') is not null as private_schema,
         exists (select 1 from pg_catalog.pg_roles where rolname = 'still_settings_writer') as writer_role;

commit;
