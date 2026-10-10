-- TEST ONLY. Apply on disposable GitHub-hosted Linux Supabase at exactly 0021, BEFORE 0022.
-- Reproduces today's deletion: account C is deleted with a paid RevenueCat-sourced right and a
-- paid QA checkout operation. The right is left detached but still active, and the operation is
-- deleted with the account. A and B stay live for the post-0022 behavior test.
begin;
do $$
begin
 if current_user<>'postgres' or session_user<>'postgres' or not exists(select 1 from pg_roles where rolname=current_user and not rolsuper and rolcreaterole)
  or current_setting('server_version_num')::integer<170000 then raise exception 'ordinary PostgreSQL17 postgres rehearsal required'; end if;
 if exists(select 1 from supabase_migrations.schema_migrations where version>='0022') then raise exception 'seed must run before 0022'; end if;
end;
$$;
insert into auth.users(id,email,email_confirmed_at) values
 ('a2222222-0000-4000-8000-000000000001','deletion-a@example.invalid',now()),
 ('b2222222-0000-4000-8000-000000000002','deletion-b@example.invalid',now()),
 ('c2222222-0000-4000-8000-000000000003','deletion-c@example.invalid',now());
insert into private.access_rights(right_id,environment,provider_key,provider_product,holder,ownership_revision,active,verified_at,provider_source) values
 -- A: active web (RevenueCat) right, an already-refunded one, and a linked Apple right.
 ('a2222222-1000-4000-8000-000000000001','sandbox',repeat('a1',32),'still_pro_v3','a2222222-0000-4000-8000-000000000001',0,true,1000,'revenuecat'),
 ('a2222222-1000-4000-8000-000000000002','production',repeat('a2',32),'still_sync','a2222222-0000-4000-8000-000000000001',2,false,1000,'revenuecat'),
 ('a2222222-1000-4000-8000-000000000003','sandbox',repeat('a3',32),'still_pro_v3','a2222222-0000-4000-8000-000000000001',1,true,1000,'apple'),
 -- B: an unrelated live account's active right.
 ('b2222222-1000-4000-8000-000000000001','sandbox',repeat('b1',32),'still_pro_v3','b2222222-0000-4000-8000-000000000002',0,true,1000,'revenuecat'),
 -- C: the account deleted below, before 0022.
 ('c2222222-1000-4000-8000-000000000001','sandbox',repeat('c1',32),'still_pro_v3','c2222222-0000-4000-8000-000000000003',0,true,1000,'revenuecat');
insert into private.qa_sandbox_purchase_operations(operation_id,holder,configuration_hash,stripe_session_id,status,creation_started_at,paid_at) values
 ('a2222222-2000-4000-8000-000000000001','a2222222-0000-4000-8000-000000000001',repeat('c',64),'cs_test_DeletionA','access_observed',now(),now()),
 ('b2222222-2000-4000-8000-000000000001','b2222222-0000-4000-8000-000000000002',repeat('c',64),'cs_test_DeletionB','session_bound',now(),null),
 ('c2222222-2000-4000-8000-000000000001','c2222222-0000-4000-8000-000000000003',repeat('c',64),'cs_test_DeletionC','access_observed',now(),now());
delete from auth.users where id='c2222222-0000-4000-8000-000000000003';
do $$
begin
 if not exists(select 1 from private.access_rights where right_id='c2222222-1000-4000-8000-000000000001' and holder is null and active)
  or exists(select 1 from private.qa_sandbox_purchase_operations where operation_id='c2222222-2000-4000-8000-000000000001') then
  raise exception 'pre-0022 deletion characterization changed';
 end if;
end;
$$;
commit;
