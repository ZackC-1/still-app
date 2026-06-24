-- RLS verification (KTD8). Run with `supabase test db` (pgTAP, wrapped in a rolled-back txn).
-- Simulates anon + two authenticated users by setting role + the request.jwt.claims GUC auth.uid()
-- reads. Asserts cross-user isolation, event/rule-set opacity, and write-path narrowness.

begin;
select plan(13);

-- ── seed (as the test superuser) ────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@test.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@test.com');

insert into public.profiles (id, settings) values
  ('11111111-1111-1111-1111-111111111111', '{"globalOn":true}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', '{"globalOn":false}'::jsonb);

select public.set_entitlement('11111111-1111-1111-1111-111111111111', true, 'test', 'sub_A');
select public.set_entitlement('22222222-2222-2222-2222-222222222222', true, 'test', 'sub_B');

insert into public.rule_sets (version, payload, signature, is_current)
  values ('1.0.0', '{"version":"1.0.0"}'::jsonb, '{"kid":"still-dev-1"}'::jsonb, true);

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
