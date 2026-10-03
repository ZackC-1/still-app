import { assert, assertEquals, assertRejects } from "@std/assert";
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

// Snapshot selected ACL/catalog truth, not a rejection string or a new approved baseline.
// All values come exclusively from the disposable synthetic runtime.
async function selectedCatalogState(sql: postgres.Sql) {
  return (await sql`
    select jsonb_build_object(
      'schemas', (select jsonb_agg(jsonb_build_object('oid', oid, 'owner', nspowner,
        'acl', nspacl::text) order by oid) from pg_catalog.pg_namespace
        where nspname in ('public', 'still_security')),
      'relations', (select jsonb_agg(jsonb_build_object('oid', c.oid,
        'owner', c.relowner, 'acl', c.relacl::text, 'rls', c.relrowsecurity,
        'columns', (select jsonb_agg(jsonb_build_object('number', a.attnum,
          'acl', a.attacl::text) order by a.attnum) from pg_catalog.pg_attribute a
          where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)) order by c.oid)
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public', 'still_security')),
      'routines', (select jsonb_agg(jsonb_build_object('oid', p.oid,
        'owner', p.proowner, 'acl', p.proacl::text, 'config', p.proconfig,
        'definer', p.prosecdef, 'source_hash', md5(p.prosrc)) order by p.oid)
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public', 'still_security')),
      'defaults', (select jsonb_agg(jsonb_build_object('creator', defaclrole,
        'schema', defaclnamespace, 'kind', defaclobjtype, 'acl', defaclacl::text)
        order by defaclrole, defaclnamespace, defaclobjtype) from pg_catalog.pg_default_acl),
      'creators', (select jsonb_agg(role_name order by role_name)
        from still_security.reconciled_creators),
      'provider', still_security.provider_descriptor('public.u1_provider_guard()'::regprocedure),
      'memberships', (select jsonb_agg(to_jsonb(m) order by roleid, member, grantor)
        from pg_catalog.pg_auth_members m),
      'probe', to_regclass('public.u1_authority_rollback_probe')
    ) as state
  `)[0].state;
}

export async function verifySyntheticHardeningAuthority(
  sql: postgres.Sql,
  fixture: postgres.Sql,
  source: (name: string) => Promise<string>,
) {
  const { admin, creators } = await inspectCatalogPreconditions(sql);
  assertEquals(admin.role, "postgres");
  assertEquals(admin.rolsuper, false);
  const managedCreator = creators.find((row) =>
    row.creator === "supabase_admin"
  );
  assert(managedCreator, "managed creator is selected by the actual catalog");
  assertEquals(managedCreator.inherited_authority, false);
  assertEquals(managedCreator.set_role_authority, false);
  assertEquals(
    (await fixture`select current_user as role, rolsuper from pg_catalog.pg_roles where rolname=current_user`)[
      0
    ],
    { role: "u1_catalog_fixture", rolsuper: true },
    "only the explicitly declared disposable administrator may apply hardening",
  );
  const before = await selectedCatalogState(sql);
  assertEquals(before.probe, null);
  assertEquals(
    (await sql`select has_table_privilege('u1_empty_creator','public.entitlements','SELECT') as allowed`)[
      0
    ].allowed,
    false,
    "the transaction must introduce an observable relation grant",
  );
  assertEquals(
    (await sql`select count(*)::int as n from still_security.reconciled_creators where role_name='u1_discovered_creator'`)[
      0
    ].n,
    0,
    "hardening must reconcile this observed creator inside its failing transaction",
  );
  const hardening = await source("hardening-candidate");
  const denied = await assertRejects(
    () =>
      sql.begin(async (tx) => {
        // Prove earlier writes and grants are real before the missing-authority rejection.
        await tx.unsafe(
          "create table public.u1_authority_rollback_probe(payload text); insert into public.u1_authority_rollback_probe values ('synthetic-rollback'); grant select on public.entitlements to u1_empty_creator",
        );
        assertEquals(
          (await tx`select payload from public.u1_authority_rollback_probe`)[0]
            .payload,
          "synthetic-rollback",
        );
        assertEquals(
          (await tx`select has_table_privilege('u1_empty_creator','public.entitlements','SELECT') as allowed`)[
            0
          ].allowed,
          true,
        );
        await tx.unsafe(hardening);
      }),
    Error,
  );
  const failure = denied as Error & { code?: string; where?: string };
  assertEquals(failure.code, "42501");
  assert(
    failure.where?.includes(
      "alter default privileges for role supabase_admin",
    ),
    "rejection must occur at the selected creator-default authority boundary",
  );
  assertEquals(
    await selectedCatalogState(sql),
    before,
    "failed non-superuser apply restores schema/table/column/routine/default ACLs, creator reconciliation, provider state and memberships",
  );
  assertEquals(
    (await sql`select current_user as role, rolsuper from pg_catalog.pg_roles where rolname=current_user`)[
      0
    ],
    admin,
    "postgres remains non-superuser after denial and rollback",
  );
}
