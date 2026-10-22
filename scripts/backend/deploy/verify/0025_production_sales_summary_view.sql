-- Read-only end-state gate for 0025_production_sales_summary_view.sql; no user data returned.
-- Returns [] only when version 0025 is recorded and still_qa_checks.production_sales_summary is a
-- postgres-owned security_barrier view with exactly its reviewed columns, reading only the two
-- product policy tables, readable by nobody except the narrow still_qa_readonly_checker (plain
-- SELECT, required whenever that role exists), with no client role reaching it or its schema.
-- Before the apply it reports migration_version and view_missing (the gate is not vacuous).
-- With no checker role, any non-owner grant on the view or schema is reported (coalesce: a NULL
-- comparison must never excuse a grant).
with v as (
 select c.oid,c.relkind,c.relowner,c.reloptions,c.relacl from pg_catalog.pg_class c
 where c.oid=pg_catalog.to_regclass('still_qa_checks.production_sales_summary')
), roles as (
 select (select oid from pg_catalog.pg_roles where rolname='postgres' and not rolsuper) as owner_oid,
  (select oid from pg_catalog.pg_roles where rolname='still_qa_readonly_checker') as checker
), ns as (
 select n.oid,n.nspowner,n.nspacl from pg_catalog.pg_namespace n where n.nspname='still_qa_checks'
), issues(code) as (
 select 'migration_version' where not exists(select 1 from supabase_migrations.schema_migrations where version='0025')
 union all select 'view_missing' where not exists(select 1 from v)
 union all select 'view_kind' from v where relkind<>'v'
 union all select 'view_owner' from v,roles where relowner is distinct from roles.owner_oid
 union all select 'view_options' from v where reloptions is distinct from array['security_barrier=true']::text[]
 union all select 'view_columns' from v where (
  select pg_catalog.string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid,a.atttypmod),',' order by a.attnum)
  from pg_catalog.pg_attribute a where a.attrelid=v.oid and a.attnum>0 and not a.attisdropped
 ) is distinct from 'sales_revision:bigint,expected_revision:bigint,sales_published_at:timestamp with time zone,'
  || 'sales_enabled:boolean,apple_enabled:boolean,apple_offer:text,web_enabled:boolean,web_offer:text,builds:jsonb,'
  || 'cutoff_present:boolean,cutoff_product:text,cutoff_benefits:text[],cutoff_sales_revision:bigint,'
  || 'cutoff_activated_at:timestamp with time zone'
 union all select 'view_reads' from v where (
  select pg_catalog.array_agg(distinct x.rel order by x.rel) from (
   select n.nspname || '.' || c.relname as rel from pg_catalog.pg_depend d
   join pg_catalog.pg_rewrite w on w.oid=d.objid
   join pg_catalog.pg_class c on c.oid=d.refobjid
   join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where d.classid='pg_catalog.pg_rewrite'::pg_catalog.regclass and w.ev_class=v.oid
    and d.refclassid='pg_catalog.pg_class'::pg_catalog.regclass and d.refobjid<>v.oid) x
 ) is distinct from array['private.paid_cutoff','private.product_policy_revisions']::text[]
 union all select 'view_grant' from v,roles cross join lateral pg_catalog.aclexplode(coalesce(v.relacl,pg_catalog.acldefault('r',v.relowner))) acl
  where acl.grantee<>v.relowner
   and not coalesce(acl.grantee=roles.checker and acl.privilege_type='SELECT' and not acl.is_grantable,false)
 union all select 'view_column_grant' from v where exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=v.oid and a.attacl is not null)
 union all select 'checker_select_missing' from v,roles where roles.checker is not null
  and not pg_catalog.has_table_privilege(roles.checker,v.oid,'SELECT')
 union all select 'client_reach' from v cross join (values ('anon'),('authenticated'),('service_role')) r(name)
  where exists(select 1 from pg_catalog.pg_roles x where x.rolname=r.name)
   and (pg_catalog.has_table_privilege(r.name,v.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or pg_catalog.has_any_column_privilege(r.name,v.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
 union all select 'schema_owner' from ns,roles where ns.nspowner is distinct from roles.owner_oid
 union all select 'schema_grant' from ns,roles cross join lateral pg_catalog.aclexplode(coalesce(ns.nspacl,pg_catalog.acldefault('n',ns.nspowner))) acl
  where acl.grantee<>ns.nspowner
   and not coalesce(acl.grantee=roles.checker and acl.privilege_type='USAGE' and not acl.is_grantable,false)
)
select coalesce(pg_catalog.json_agg(distinct code order by code),'[]'::json) as issues from issues;
