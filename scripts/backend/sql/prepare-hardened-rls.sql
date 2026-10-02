-- TEST ONLY: the cloud rehearsal installs pgTAP after the hardened global default ACLs.
-- Keep test helpers in extensions and grant only this extension's routines, never application RPCs.
create extension if not exists pgtap with schema extensions;
grant usage on schema extensions to anon, authenticated;
do $$ declare signature text; begin
  if not exists (select 1 from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgtap' and n.nspname = 'extensions') then
    raise exception 'Rehearsal pgTAP must be installed in extensions';
  end if;
  for signature in
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc p
    join pg_catalog.pg_depend d on d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid
    join pg_catalog.pg_extension e on e.oid = d.refobjid
    where d.refclassid = 'pg_catalog.pg_extension'::regclass and d.deptype = 'e' and e.extname = 'pgtap'
  loop
    execute format('grant execute on function %s to anon, authenticated', signature);
  end loop;
end $$;
