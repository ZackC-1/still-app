-- TEST ONLY. Apply on disposable GitHub-hosted Linux Supabase after 0020 and BEFORE 0021.
-- Clean-install test may run this after 0021; pre_state distinguishes its evidence honestly.
begin;
create schema qa_sandbox_fixture;
revoke all on schema qa_sandbox_fixture from public;
insert into auth.users(id,email,email_confirmed_at) values
 ('a2121212-0000-4000-8000-000000000001','qa-ledger-a@example.invalid',now()),
 ('b2121212-0000-4000-8000-000000000002','qa-ledger-b@example.invalid',now()),
 ('c2121212-0000-4000-8000-000000000003','qa-ledger-nonmember@example.invalid',now());
insert into public.entitlements(user_id,still_sync,source,revenuecat_subscriber_id)
 values('a2121212-0000-4000-8000-000000000001',true,'webhook','synthetic-legacy-qa-ledger');
-- Old writer behavior produces production rights before the upgrade; exact retries characterize it.
do $$
declare token uuid; result jsonb; replay jsonb;
begin
 token:=public.begin_access_observation('a2121212-0000-4000-8000-000000000001','production');
 result:=public.commit_access_observation('a2121212-0000-4000-8000-000000000001','production',token,
  '[{"key":"2121212121212121212121212121212121212121212121212121212121212121","product":"still_sync"}]');
 replay:=public.commit_access_observation('a2121212-0000-4000-8000-000000000001','production',token,
  '[{"key":"2121212121212121212121212121212121212121212121212121212121212121","product":"still_sync"}]');
 if result is distinct from replay or result->>'status'<>'committed'
  or not public.confirm_access_observation('a2121212-0000-4000-8000-000000000001','production',token) then
  raise exception 'pre-upgrade live characterization failed'; end if;
end;
$$;
create table qa_sandbox_fixture.pre_state as select
 pg_catalog.to_regprocedure('public.qa_sandbox_begin_access_observation(uuid)') is not null as qa_present, false as absent_invocation_rejected;
do $$
begin
 if not (select qa_present from qa_sandbox_fixture.pre_state) then
  begin
   execute 'select public.qa_sandbox_begin_access_observation(''a2121212-0000-4000-8000-000000000001''::uuid)';
   raise exception 'unexpected pre-upgrade QA wrapper';
  exception when undefined_function then
   update qa_sandbox_fixture.pre_state set absent_invocation_rejected=true;
  end;
 end if;
end;
$$;
create view qa_sandbox_fixture.fingerprints as
 select 'profiles' as name,md5(coalesce(jsonb_agg(to_jsonb(r) order by id)::text,'')) as digest from public.profiles r
 union all select 'entitlements',md5(coalesce(jsonb_agg(to_jsonb(r) order by user_id)::text,'')) from public.entitlements r
 union all select 'rights',md5(coalesce(jsonb_agg(to_jsonb(r) order by right_id)::text,'')) from private.access_rights r
 union all select 'observations',md5(coalesce(jsonb_agg(to_jsonb(r) order by holder,environment)::text,'')) from private.access_observations r
 union all select 'revocations',md5(coalesce(jsonb_agg(to_jsonb(r) order by holder,environment,right_id)::text,'')) from private.access_revocations r
 union all select 'transfers',md5(coalesce(jsonb_agg(to_jsonb(r) order by operation_id)::text,'')) from private.access_transfer_operations r
 union all select 'apple_observations',md5(coalesce(jsonb_agg(to_jsonb(r) order by environment,provider_key)::text,'')) from private.apple_access_observations r
 union all select 'apple_links',md5(coalesce(jsonb_agg(to_jsonb(r) order by operation_id)::text,'')) from private.apple_access_link_operations r
 union all select 'policy_revisions',md5(coalesce(jsonb_agg(to_jsonb(r) order by namespace,environment,revision)::text,'')) from private.product_policy_revisions r
 union all select 'paid_cutoff',md5(coalesce(jsonb_agg(to_jsonb(r) order by environment)::text,'')) from private.paid_cutoff r;
create table qa_sandbox_fixture.baseline as select * from qa_sandbox_fixture.fingerprints;
create table qa_sandbox_fixture.live_routines as select p.oid::regprocedure::text as signature,p.prosrc,p.proacl,p.proowner,p.proconfig
 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('begin_access_observation','commit_access_observation','confirm_access_observation',
 'transfer_access_right','begin_apple_access_observation','commit_apple_access_observation','confirm_apple_access_observation',
 'read_linked_apple_transactions','read_access_removals');
commit;
