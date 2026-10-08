-- Read-only 0021 catalog gate. Returns [] only for the exact reviewed bodies/roles/ACLs.
-- No account, transaction identity, credential or private provider payload is returned.
with expected(signature,owner,definer,body_md5,execute_role) as (values
 ('private.begin_access_observation_core(uuid,text)','postgres',false,'c38d125ea8557e5bfd2705123b7c5ee2','still_qa_sandbox_owner'),
 ('public.begin_access_observation(uuid,text)','postgres',true,'4918b74b2c10bd706b82dffee0335412','still_entitlement_writer'),
 ('private.commit_access_observation_core(uuid,text,uuid,jsonb)','postgres',false,'2f3c1aa3b2ccafd018d20378a92c8429','still_qa_sandbox_owner'),
 ('public.commit_access_observation(uuid,text,uuid,jsonb)','postgres',true,'e44ef2731c8d546faf000231906739f8','still_entitlement_writer'),
 ('private.confirm_access_observation_core(uuid,text,uuid)','postgres',false,'cc4e79e990537f22fd6e842b01b16d74','still_qa_sandbox_owner'),
 ('public.confirm_access_observation(uuid,text,uuid)','postgres',true,'a9b1a6af299c4046e3215e9710780175','still_entitlement_writer'),
 ('private.transfer_access_right_core(uuid,uuid,text,uuid,uuid,bigint)','postgres',false,'42292f7f9d1b38d035da9c237175c5ce','still_qa_sandbox_owner'),
 ('public.transfer_access_right(uuid,uuid,text,uuid,uuid,bigint)','postgres',true,'22dd4b425da7010dcdb75c454136164b','still_entitlement_writer'),
 ('private.begin_apple_access_observation_core(text,text,text,text,text)','postgres',false,'b351d4d43b77984fbace1d4d521221d6','still_qa_sandbox_owner'),
 ('public.begin_apple_access_observation(text,text,text,text,text)','postgres',true,'049d250a6c29c093fca93f54d5b5e42b','still_entitlement_writer'),
 ('private.commit_apple_access_observation_core(text,text,uuid,boolean,uuid,uuid,bigint,uuid)','postgres',false,'ab9fc6713ed8a22b19844a2a6b37e54b','still_qa_sandbox_owner'),
 ('public.commit_apple_access_observation(text,text,uuid,boolean,uuid,uuid,bigint,uuid)','postgres',true,'3d9903c5009d3a383ad2ccfaffc454ea','still_entitlement_writer'),
 ('private.confirm_apple_access_observation_core(text,text,uuid,uuid,uuid,bigint,bigint)','postgres',false,'98491c940d8357bcf9bbe239d806dd68','still_qa_sandbox_owner'),
 ('public.confirm_apple_access_observation(text,text,uuid,uuid,uuid,bigint,bigint)','postgres',true,'95ca51d90659174606564c17681d7a44','still_entitlement_writer'),
 ('private.read_linked_apple_transactions_core(uuid,text)','postgres',false,'2f7b11fb38ef267c42dba0a3ed9a25da','still_qa_sandbox_owner'),
 ('public.read_linked_apple_transactions(uuid,text)','postgres',true,'e7e252a83e0027c14c7a1b6cb2a29690','still_entitlement_writer'),
 ('private.read_access_removals_core(uuid,text,uuid)','postgres',false,'7f5de98929e198bf999149a44b090295','still_qa_sandbox_owner'),
 ('public.read_access_removals(uuid,text,uuid)','postgres',true,'aebc3ad303e8663fea69e91809c5bf1d','still_entitlement_writer'),
 ('private.qa_sandbox_session()','postgres',false,'f9a9663df4c1ee634debec3269f135e8','still_qa_sandbox_owner'),
 ('private.qa_sandbox_confirmed_account(uuid)','postgres',true,'dba2f2f067f8627300b7c16c76cebb05','still_qa_sandbox_owner'),
 ('private.qa_sandbox_subject(uuid,boolean)','postgres',false,'9d966e0a33185ee41040114efd5a22b6','still_qa_sandbox_owner'),
 ('public.qa_sandbox_account_enabled(uuid)','still_qa_sandbox_owner',true,'4b128e44b432a8e18c8cd4a10c103107','still_qa_sandbox_writer'),
 ('public.qa_sandbox_begin_access_observation(uuid)','still_qa_sandbox_owner',true,'716b02117e9d0ebfa35912d6ef2ef00f','still_qa_sandbox_writer'),
 ('public.qa_sandbox_commit_access_observation(uuid,uuid,jsonb)','still_qa_sandbox_owner',true,'b7f0b11ff56d4f569f0f25dce792639a','still_qa_sandbox_writer'),
 ('public.qa_sandbox_confirm_access_observation(uuid,uuid)','still_qa_sandbox_owner',true,'df573ca762862755efd4cda3a03fe45a','still_qa_sandbox_writer'),
 ('public.qa_sandbox_read_access_removals(uuid,uuid)','still_qa_sandbox_owner',true,'fd14e1a26a488064bb7098e67b1a3123','still_qa_sandbox_writer'),
 ('public.qa_sandbox_transfer_access_right(uuid,uuid,uuid,uuid,bigint)','still_qa_sandbox_owner',true,'789a948ef5af2ef0d83946cd893ae403','still_qa_sandbox_writer'),
 ('public.qa_sandbox_begin_apple_access_observation(text,text,text,text)','still_qa_sandbox_owner',true,'324864634f6201d4140e4659f3bad93a','still_qa_sandbox_writer'),
 ('public.qa_sandbox_commit_apple_local(text,uuid,boolean)','still_qa_sandbox_owner',true,'70eb29aa3f006810b8e2b3a3685c4bd9','still_qa_sandbox_writer'),
 ('public.qa_sandbox_commit_apple_link(text,uuid,boolean,uuid,uuid,bigint,uuid)','still_qa_sandbox_owner',true,'bf7ca5f3c5a724862d45f1803cc3d8b2','still_qa_sandbox_writer'),
 ('public.qa_sandbox_confirm_apple_local(text,uuid,uuid,bigint,bigint)','still_qa_sandbox_owner',true,'fb61a7bc1f06facb09f76aee2360db04','still_qa_sandbox_writer'),
 ('public.qa_sandbox_confirm_apple_account(text,uuid,uuid,uuid,bigint,bigint)','still_qa_sandbox_owner',true,'bbf4be1efd59ba27ef41d8c8eca0c209','still_qa_sandbox_writer'),
 ('public.qa_sandbox_read_linked_apple_transactions(uuid)','still_qa_sandbox_owner',true,'8793c296d922a54842648b244df95326','still_qa_sandbox_writer'),
 ('public.qa_sandbox_prepare_checkout_operation(uuid,uuid,text)','still_qa_sandbox_owner',true,'487869bd4be9ab2711d251c58d6b6725','still_qa_sandbox_writer'),
 ('public.qa_sandbox_claim_checkout_creation(uuid,uuid,text)','still_qa_sandbox_owner',true,'6d387cc871c4dc41eee8d98543fe9cb1','still_qa_sandbox_writer'),
 ('public.qa_sandbox_bind_checkout_session(uuid,uuid,text,text)','still_qa_sandbox_owner',true,'ecdea1e4c5705c7afa219c40a66f847c','still_qa_sandbox_writer'),
 ('public.qa_sandbox_read_checkout_operation(uuid,uuid)','still_qa_sandbox_owner',true,'8586d443772ba39ceaf8317d4216237c','still_qa_sandbox_writer'),
 ('public.qa_sandbox_record_checkout_status(uuid,text,text)','still_qa_sandbox_owner',true,'5e7138516d3f8561921f6dd8eda434c5','still_qa_sandbox_writer'),
 ('public.qa_sandbox_consume_rate_limit(text,integer,integer)','still_qa_sandbox_owner',true,'de6233e1d69b0aa0971fed9303c0cd76','still_qa_sandbox_writer')
), routines as (
 select e.*,p.oid,p.proowner,p.prosecdef,p.proconfig,p.prosrc,p.proacl
 from expected e left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(e.signature)
), issues as (
 select 'missing_routine:'||signature as code from routines where oid is null
 union all select 'routine_owner:'||signature from routines where proowner is distinct from (select oid from pg_catalog.pg_roles where rolname=owner)
 union all select 'routine_definer:'||signature from routines where prosecdef is distinct from definer
 union all select 'routine_body:'||signature from routines where md5(prosrc) is distinct from body_md5
 union all select 'routine_path:'||signature from routines where proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
 union all select 'routine_acl:'||signature from routines r where
  (select array_agg(a.grantee order by a.grantee) from pg_catalog.aclexplode(coalesce(r.proacl,pg_catalog.acldefault('f',r.proowner))) a where a.privilege_type='EXECUTE')
  is distinct from (select array_agg(oid order by oid) from pg_catalog.pg_roles where rolname in (r.owner,r.execute_role))
 union all select 'routine_grant_option:'||signature from routines r,lateral pg_catalog.aclexplode(r.proacl) a where a.grantee<>r.proowner and a.is_grantable
 union all select 'unsafe_QA_role:'||rolname from pg_catalog.pg_roles where rolname in ('still_qa_sandbox_writer','still_qa_sandbox_owner')
  and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit or (rolname='still_qa_sandbox_owner' and rolcanlogin))
 union all select 'missing_QA_role' where (select count(*) from pg_catalog.pg_roles where rolname in ('still_qa_sandbox_writer','still_qa_sandbox_owner'))<>2
 union all select 'QA_role_membership' where exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.member
  where r.rolname in ('still_qa_sandbox_writer','still_qa_sandbox_owner')) or exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.roleid where r.rolname='still_qa_sandbox_owner')
 union all select 'QA_owner_schema_create' where pg_catalog.has_schema_privilege('still_qa_sandbox_owner','public','CREATE')
 union all select 'QA_live_RPC:'||signature from expected where signature like 'public.%' and signature not like 'public.qa_sandbox_%'
  and pg_catalog.has_function_privilege('still_qa_sandbox_writer',signature,'EXECUTE')
 union all select 'QA_internal_core:'||signature from expected where signature like 'private.%'
  and pg_catalog.has_function_privilege('still_qa_sandbox_writer',signature,'EXECUTE')
 union all select 'QA_direct_table:'||c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where ((n.nspname='private' and c.relname in ('qa_sandbox_subjects','qa_sandbox_purchase_operations','qa_sandbox_negative_rights','qa_sandbox_rate_windows','qa_sandbox_rate_counters',
   'access_rights','access_observations','access_revocations','access_transfer_operations','apple_access_observations','apple_access_link_operations')) or (n.nspname='public' and c.relname='entitlements'))
   and (pg_catalog.has_table_privilege('still_qa_sandbox_writer',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or pg_catalog.has_any_column_privilege('still_qa_sandbox_writer',c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
 union all select 'QA_missing_table_or_RLS:'||name from unnest(array['qa_sandbox_subjects','qa_sandbox_purchase_operations','qa_sandbox_negative_rights','qa_sandbox_rate_windows','qa_sandbox_rate_counters']) name
  where not exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname=name and c.relrowsecurity)
 union all select 'QA_new_table_ACL:'||c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace,
  lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
  where n.nspname='private' and c.relname in ('qa_sandbox_subjects','qa_sandbox_purchase_operations','qa_sandbox_negative_rights','qa_sandbox_rate_windows','qa_sandbox_rate_counters')
   and a.grantee<>c.relowner and (a.grantee is distinct from (select oid from pg_catalog.pg_roles where rolname='still_qa_sandbox_owner') or a.is_grantable)
 union all select 'QA_new_column_ACL:'||c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  join pg_catalog.pg_attribute col on col.attrelid=c.oid,lateral pg_catalog.aclexplode(col.attacl) a
  where n.nspname='private' and c.relname in ('qa_sandbox_subjects','qa_sandbox_purchase_operations','qa_sandbox_negative_rights','qa_sandbox_rate_windows','qa_sandbox_rate_counters')
   and a.grantee<>c.relowner and (a.grantee is distinct from (select oid from pg_catalog.pg_roles where rolname='still_qa_sandbox_owner') or a.is_grantable)
 union all select 'QA_owner_auth_mutation' where pg_catalog.has_table_privilege('still_qa_sandbox_owner','auth.users','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  or pg_catalog.has_any_column_privilege('still_qa_sandbox_owner','auth.users','INSERT,UPDATE,REFERENCES')
 union all select 'QA_owner_legacy_mutation' where pg_catalog.has_table_privilege('still_qa_sandbox_owner','public.entitlements','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  or pg_catalog.has_any_column_privilege('still_qa_sandbox_owner','public.entitlements','INSERT,UPDATE,REFERENCES')
 union all select 'QA_wrong_RLS_policy:'||t.name from unnest(array['access_observations','access_rights','access_revocations','access_transfer_operations','apple_access_observations','apple_access_link_operations']) t(name)
  where not exists(select 1 from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where n.nspname='private' and c.relname=t.name and p.polname='qa_sandbox_owner' and p.polroles=array[(select oid from pg_catalog.pg_roles where rolname='still_qa_sandbox_owner')]
    and pg_catalog.pg_get_expr(p.polqual,p.polrelid)='(environment = ''sandbox''::text)' and pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)='(environment = ''sandbox''::text)')
 union all select 'QA_client_RPC:'||e.signature from expected e,pg_catalog.pg_roles r where e.signature like 'public.qa_sandbox_%'
  and r.rolname in ('anon','authenticated','service_role','still_entitlement_writer') and pg_catalog.has_function_privilege(r.oid,e.signature,'EXECUTE')
)
select coalesce(json_agg(code order by code),'[]'::json) from (select distinct code from issues) sorted;
