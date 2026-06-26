-- RLS verification (KTD8). Run with `supabase test db` (pgTAP, wrapped in a rolled-back txn).
-- Simulates anon + two authenticated users by setting role + the request.jwt.claims GUC auth.uid()
-- reads. Asserts cross-user isolation, event/rule-set opacity, and write-path narrowness.

begin;
select plan(20);

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

select lives_ok(
  $$ update public.profiles set settings = '{"globalOn":false}'::jsonb where id = '11111111-1111-1111-1111-111111111111' $$,
  'entitled A can update its own synced profile'
);

reset role;

-- ── as un-entitled user C ───────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333"}';

select throws_ok(
  $$ insert into public.profiles (id, settings) values ('33333333-3333-3333-3333-333333333333', '{"globalOn":true}'::jsonb) $$,
  '42501', NULL, 'un-entitled user cannot insert a synced profile'
);

reset role;

-- Seed C a profile row as superuser (bypasses RLS), then prove an un-entitled UPDATE is denied.
-- The UPDATE policy gates via USING, so a denied update silently affects 0 rows (NOT a 42501) —
-- assert both the 0-row count and that the stored row is unchanged.
insert into public.profiles (id, settings)
  values ('33333333-3333-3333-3333-333333333333', '{"globalOn":true}'::jsonb);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333"}';

-- Data-modifying CTE must sit at the statement top level (can't nest inside the is() argument).
with upd as (
  update public.profiles set settings = '{"globalOn":false}'::jsonb
  where id = '33333333-3333-3333-3333-333333333333'
  returning 1
)
select is((select count(*)::int from upd), 0,
          'un-entitled user''s profile UPDATE is silently denied (0 rows via the USING gate)');

select is(
  (select settings->>'globalOn' from public.profiles where id = '33333333-3333-3333-3333-333333333333'),
  'true', 'the denied UPDATE left the row unchanged');

reset role;

-- ── as entitled user D — positive INSERT path through the new RLS policy ──────────
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444"}';

select lives_ok(
  $$ insert into public.profiles (id, settings) values ('44444444-4444-4444-4444-444444444444', '{"globalOn":true}'::jsonb) $$,
  'entitled user can insert its own synced profile (INSERT with-check entitlement subquery passes)'
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

reset role;

-- ── cascade delete removes dependent rows ────────────────────────────────────────
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select is(
  (select count(*)::int from public.profiles where id = '11111111-1111-1111-1111-111111111111')
  + (select count(*)::int from public.entitlements where user_id = '11111111-1111-1111-1111-111111111111'),
  0, 'deleting the auth user cascades to profile + entitlement');

select * from finish();
rollback;
