import { assert, assertEquals, assertRejects } from "@std/assert";
import type postgres from "postgres";

type MutationProbe = (
  mutation: string,
  verify: (mutant: postgres.TransactionSql) => Promise<void>,
) => Promise<void>;

// These probes share the rehearsal transaction and rollback verifier.
export async function verifyCreatorCatalog(
  sql: postgres.Sql,
  probeMutation: MutationProbe,
  assertSecurityRejected: (mutant: postgres.TransactionSql) => Promise<void>,
  hardening: string,
) {
  assertEquals(
    (await sql`select count(*)::int as n from still_security.reconciled_creators where role_name='u1_discovered_creator'`)[
      0
    ].n,
    1,
    "retain observed creator after its last public default ACL is removed",
  );
  for (
    const creator of [
      "u1_empty_creator",
      "u1_default_creator",
      "u1_discovered_creator",
    ]
  ) {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${creator}`);
      await tx.unsafe(
        "create function public.u1_future_rpc() returns boolean language sql as 'select true'; create table public.u1_future_table(payload text); create sequence public.u1_future_sequence",
      );
      for (const role of ["anon", "authenticated"]) {
        assertEquals(
          (await tx`select has_function_privilege(${role},'public.u1_future_rpc()','EXECUTE') as allowed`)[
            0
          ].allowed,
          false,
        );
        assertEquals(
          (await tx`select has_table_privilege(${role},'public.u1_future_table','SELECT,INSERT,UPDATE,DELETE') as allowed`)[
            0
          ].allowed,
          false,
        );
        assertEquals(
          (await tx`select has_sequence_privilege(${role},'public.u1_future_sequence','USAGE,SELECT,UPDATE') as allowed`)[
            0
          ].allowed,
          false,
        );
      }
      await tx.unsafe(
        "drop function public.u1_future_rpc(); drop table public.u1_future_table; drop sequence public.u1_future_sequence",
      );
    });
    for (
      const mutation of [
        `alter default privileges for role ${creator} grant execute on functions to public`,
        `alter default privileges for role ${creator} in schema public grant execute on functions to anon`,
        `alter default privileges for role ${creator} in schema public grant select on tables to authenticated`,
        `alter default privileges for role ${creator} in schema public grant usage on sequences to anon`,
      ]
    ) {
      await probeMutation(mutation, async (mutant) => {
        await assertSecurityRejected(mutant);
      });
    }
  }
  await probeMutation(
    "create role u1_late_creator; grant u1_late_creator to current_user; alter default privileges for role u1_late_creator in schema public grant execute on functions to authenticated",
    async (mutant) => {
      await assertSecurityRejected(mutant);
    },
  );

  const grantsBefore =
    await sql`select relacl::text as acl from pg_catalog.pg_class where oid='public.entitlements'::regclass`;
  await probeMutation(
    "insert into still_security.reconciled_creators(role_name) values ('u1_missing_creator'); grant update on public.entitlements to authenticated",
    async (mutant) => {
      assert(
        (await mutant`select issue from still_security.audit()`).some((row) =>
          row.issue === "unresolved_creator"
        ),
      );
      await assertSecurityRejected(mutant);
      const injectedGrants =
        await mutant`select relacl::text as acl from pg_catalog.pg_class where oid='public.entitlements'::regclass`;
      assert(
        injectedGrants[0].acl !== grantsBefore[0].acl,
        "grant injection changes the ACL before the rollback test",
      );
      const denied = await assertRejects(
        () => mutant.savepoint((attempt) => attempt.unsafe(hardening)),
        Error,
        "Unresolved reconciled creator",
      );
      assertEquals((denied as Error & { code?: string }).code, "42501");
      assertEquals(
        await mutant`select relacl::text as acl from pg_catalog.pg_class where oid='public.entitlements'::regclass`,
        injectedGrants,
        "failed hardening rolls back earlier privilege changes",
      );
    },
  );
  assertEquals(
    await sql`select relacl::text as acl from pg_catalog.pg_class where oid='public.entitlements'::regclass`,
    grantsBefore,
    "mutation rollback restores the original grants",
  );
}
