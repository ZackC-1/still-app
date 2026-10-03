import type postgres from "postgres";

export async function inspectCatalogPreconditions(sql: postgres.Sql) {
  // Only the disposable runner is queried. Report values for the explicitly generic fixture;
  // bodies are represented by equality alone, including when additional routines exist.
  const providerDiagnostic = (await sql`
    with generic as (
      select still_security.provider_descriptor('public.u1_provider_guard()'::regprocedure) as actual,
        (select descriptor from still_security.approved_provider_routines
          where routine='public.u1_provider_guard()') as reviewed
    ) select coalesce(actual = reviewed, false) as generic_matches,
      coalesce(actual->'body' = reviewed->'body', false) as body_matches,
      coalesce((select jsonb_agg(jsonb_build_object(
        'field', field, 'actual', actual->field, 'reviewed', reviewed->field) order by field)
        from (select jsonb_object_keys(coalesce(actual, '{}'::jsonb) - 'body') as field
          union select jsonb_object_keys(coalesce(reviewed, '{}'::jsonb) - 'body')) fields
        where actual->field is distinct from reviewed->field), '[]'::jsonb) as differing_fields,
      (select coalesce(jsonb_agg(jsonb_build_object(
        'routine', n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
        'owner', pg_catalog.pg_get_userbyid(p.proowner)) order by p.oid), '[]'::jsonb)
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prorettype='pg_catalog.event_trigger'::regtype
          and not exists (select 1 from still_security.approved_provider_routines a
            where a.routine=n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'))
        as unapproved_routines
    from generic
  `)[0];
  // Match hardening's creator selection, including creators observed before their public ACLs
  // are removed. PostgreSQL checks inherited authority (USAGE), not just membership or SET.
  const creatorAuthority = await sql`
    select r.rolname as creator, r.rolsuper as creator_superuser,
      pg_catalog.pg_has_role(current_user, r.oid, 'USAGE') as inherited_authority,
      pg_catalog.pg_has_role(current_user, r.oid, 'SET') as set_role_authority
    from pg_catalog.pg_roles r where r.oid in (
      select p.proowner from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prosecdef
      union select c.relowner from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r', 'p')
      union select oid from pg_catalog.pg_roles where rolname=current_user
      union select r.oid from pg_catalog.pg_roles r join still_security.reconciled_creators c on c.role_name=r.rolname
      union select d.defaclrole from pg_catalog.pg_default_acl d join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace
        where n.nspname='public'
    ) order by r.rolname
  `;
  const adminRole = (await sql`
    select current_user as role, rolsuper from pg_catalog.pg_roles where rolname=current_user
  `)[0];
  return {
    admin: adminRole,
    provider: providerDiagnostic,
    creators: creatorAuthority,
  };
}
