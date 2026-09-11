-- RLS verification (KTD8). Run with `supabase test db` (pgTAP, wrapped in a rolled-back txn).
-- Simulates anon + two authenticated users by setting role + the request.jwt.claims GUC auth.uid()
-- reads. Asserts cross-user isolation, event/rule-set opacity, and write-path narrowness.

begin;
select plan(33);

-- ── seed (as the test superuser) ────────────────────────────────────────────────
-- A, B: entitled. C: un-entitled (negative write paths). D: entitled (positive INSERT path).
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@test.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@test.com'),
  ('33333333-3333-3333-3333-333333333333', 'c@test.com'),
  ('44444444-4444-4444-4444-444444444444', 'd@test.com');

insert into public.profiles (id, settings) values
  ('11111111-1111-1111-1111-111111111111', '{"globalOn":true}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', '{"globalOn":false}'::jsonb);

select public.set_entitlement('11111111-1111-1111-1111-111111111111', true, 'test', 'sub_A');
select public.set_entitlement('22222222-2222-2222-2222-222222222222', true, 'test', 'sub_B');
select public.set_entitlement('44444444-4444-4444-4444-444444444444', true, 'test', 'sub_D');

-- Migrations already seed a current rule set (0004/0006); keep this idempotent so re-running against a
-- migrated DB doesn't collide on the version PK or create a second is_current row.
insert into public.rule_sets (version, payload, signature, is_current)
  values ('1.0.0', '{"version":"1.0.0"}'::jsonb, '{"kid":"still-dev-1"}'::jsonb, true)
  on conflict (version) do nothing;

-- ── as user A ────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111"}';

select is((select count(*)::int from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
          1, 'A reads its own profile');
select is((select count(*)::int from public.entitlements where user_id = '11111111-1111-1111-1111-111111111111'),
          1, 'A reads its own entitlement');
select is((select count(*)::int from public.entitlements where user_id = '22222222-2222-2222-2222-222222222222'),
          0, 'A cannot read B''s entitlement (no UUID enumeration)');
select is((select count(*)::int from public.profiles),
          1, 'A sees only its own profile row');
select is((select count(*)::int from public.revenuecat_events),
          0, 'revenuecat_events is opaque to authenticated users');
select is((select count(*)::int from public.rule_sets),
          0, 'raw rule_sets is not directly readable');
select is((select count(*)::int from public.get_current_rule_set()),
          1, 'the current rule set is readable via the RPC');

-- Column-level grant (0007): A reads its own still_sync, but the internal revenuecat_subscriber_id
-- column is denied even on its own row.
select is((select still_sync from public.entitlements where user_id = '11111111-1111-1111-1111-111111111111'),
          true, 'A reads its own still_sync column');
select throws_ok(
  $$ select revenuecat_subscriber_id from public.entitlements where user_id = '11111111-1111-1111-1111-111111111111' $$,
  '42501', NULL, 'A cannot read the internal revenuecat_subscriber_id column (column-level grant)'
);

-- A cannot write its own entitlement: no UPDATE grant → denied outright.
select throws_ok(
  $$ update public.entitlements set still_sync = false where user_id = '11111111-1111-1111-1111-111111111111' $$,
  '42501', NULL, 'A cannot update its own entitlement (no write privilege)'
);

-- A cannot execute the narrow write RPC.
select throws_ok(
  $$ select public.set_entitlement('11111111-1111-1111-1111-111111111111'::uuid, false, 'x', 'y') $$,
  '42501', NULL, 'authenticated cannot execute set_entitlement'
);

select throws_ok(
  $$ update public.profiles set settings = '{"globalOn":false}'::jsonb where id = '11111111-1111-1111-1111-111111111111' $$,
  '42501', NULL, 'authenticated users cannot directly update profiles after RPC migration'
);

select lives_ok(
  $$ select public.write_profile_settings('{"globalOn":false,"services":{"youtube":true,"instagram":true,"tiktok":true,"facebook":true},"pauses":[],"updatedAt":1}'::jsonb, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'::uuid) $$,
  'entitled A can write settings through write_profile_settings'
);

select is(
  (select settings_version::int from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  1, 'first accepted RPC write sets settings_version to 1'
);

select is(
  (select settings_last_write_id::text from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', 'RPC stores the last write id'
);

reset role;

select lives_ok($$
  create temp table profile_clock_probe as
  select settings_server_updated_at as first_stamp
  from public.profiles
  where id = '11111111-1111-1111-1111-111111111111'
$$, 'test captures first server settings timestamp');
grant select on profile_clock_probe to authenticated;

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111"}';

select lives_ok(
  $$ select public.write_profile_settings('{"globalOn":true,"services":{"youtube":true,"instagram":true,"tiktok":true,"facebook":true},"pauses":[],"updatedAt":9999999999999}'::jsonb, 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'::uuid) $$,
  'second accepted RPC write succeeds even with a skewed device updatedAt'
);

select is(
  (select settings_version::int from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  2, 'second accepted RPC write increments settings_version to 2'
);

select ok(
  (select settings_server_updated_at > first_stamp from public.profiles, profile_clock_probe where id = '11111111-1111-1111-1111-111111111111'),
  'RPC advances settings_server_updated_at on accepted writes'
);

reset role;

-- ── as un-entitled user C ───────────────────────────────────────────────────────
-- Settings sync is available to anyone with an account (migration 0012), so C writes through the
-- RPC even though C owns nothing. The narrowness of the write path is unchanged: the RPC is still
-- the only route, direct table writes are still denied, and the subject still comes from auth.uid().
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333"}';

select throws_ok(
  $$ insert into public.profiles (id, settings) values ('33333333-3333-3333-3333-333333333333', '{"globalOn":true}'::jsonb) $$,
  '42501', NULL, 'authenticated user cannot directly insert a synced profile'
);

select lives_ok(
  $$ select public.write_profile_settings('{"globalOn":true}'::jsonb, 'cccccccc-cccc-4ccc-cccc-cccccccccccc'::uuid) $$,
  'an account with no entitlement can write settings through the RPC'
);

select is(
  (select settings_version::int from public.profiles where id = '33333333-3333-3333-3333-333333333333'),
  1, 'the un-entitled write created C''s profile row rather than being refused'
);

-- C's row now exists because the RPC created it, so nothing is seeded here. Prove that a direct
-- UPDATE is still denied: direct grants are revoked, so it fails before RLS can silently filter.

-- Data-modifying CTE must sit at the statement top level (can't nest inside the is() argument).
select throws_ok(
  $$ update public.profiles set settings = '{"globalOn":false}'::jsonb where id = '33333333-3333-3333-3333-333333333333' $$,
  '42501', NULL, 'un-entitled user cannot directly update a profile'
);

select is(
  (select settings->>'globalOn' from public.profiles where id = '33333333-3333-3333-3333-333333333333'),
  'true', 'the denied UPDATE left the row unchanged');

reset role;

-- ── as entitled user D — direct INSERT denied; RPC insert path succeeds ──────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444"}';

select throws_ok(
  $$ insert into public.profiles (id, settings) values ('44444444-4444-4444-4444-444444444444', '{"globalOn":true}'::jsonb) $$,
  '42501', NULL, 'entitled user cannot directly insert its own synced profile'
);

select lives_ok(
  $$ select public.write_profile_settings('{"globalOn":true,"services":{"youtube":true,"instagram":true,"tiktok":true,"facebook":true},"pauses":[],"updatedAt":1}'::jsonb, 'dddddddd-dddd-4ddd-dddd-dddddddddddd'::uuid) $$,
  'entitled user can create its own synced profile through the RPC'
);

select is(
  (select id from public.profiles where id = '44444444-4444-4444-4444-444444444444')::text,
  '44444444-4444-4444-4444-444444444444', 'RPC derives the inserted profile id from auth.uid()'
);

select throws_ok(
  $$ select public.write_profile_settings('[]'::jsonb, 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee'::uuid) $$,
  '22023', NULL, 'RPC rejects non-object settings JSON'
);

reset role;

-- ── as anon ──────────────────────────────────────────────────────────────────────
set local role anon;
set local request.jwt.claims to '{}';

select is((select count(*)::int from public.rule_sets), 0, 'anon cannot enumerate raw rule_sets');
select is((select count(*)::int from public.get_current_rule_set()), 1, 'anon reads the current rule set via RPC');
select throws_ok(
  $$ insert into public.rule_sets (version, payload, signature) values ('9.9.9', '{}'::jsonb, '{}'::jsonb) $$,
  '42501', NULL, 'anon cannot insert into rule_sets'
);

select throws_ok(
  $$ select public.write_profile_settings('{"globalOn":true}'::jsonb, 'ffffffff-ffff-4fff-ffff-ffffffffffff'::uuid) $$,
  '42501', NULL, 'anon cannot execute write_profile_settings'
);

reset role;

-- ── cascade delete removes dependent rows ────────────────────────────────────────
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select is(
  (select count(*)::int from public.profiles where id = '11111111-1111-1111-1111-111111111111')
  + (select count(*)::int from public.entitlements where user_id = '11111111-1111-1111-1111-111111111111'),
  0, 'deleting the auth user cascades to profile + entitlement');

select * from finish();
rollback;
