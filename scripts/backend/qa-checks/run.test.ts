import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
import { CHECK_VIEWS, MIGRATION_VIEWS } from "./sql-guard.mjs";
import {
  CHECKER_ROLE,
  CheckError,
  compareProduction,
  describeFailure,
  encryptReport,
  EXPECTED_ROLE_CONFIG,
  grantedMigrationViews,
  PRODUCTION_FAILURES,
  productionDigest,
  requireCheckerSession,
  requireMigrationViews,
  sessionProblems,
  verdictFor,
} from "./run.ts";
import { resolveRequest } from "./catalogue.mjs";

const narrow = {
  user: CHECKER_ROLE,
  superuser: false,
  bypassrls: false,
  createrole: false,
  createdb: false,
  replication: false,
  inherit: false,
  memberships: 0,
  read_only: "on",
  own_grants: CHECK_VIEWS.length,
  foreign_grants: 0,
  migration_grants: Object.keys(MIGRATION_VIEWS).join(","),
  writable: 0,
  direct_reads: 0,
  create_schemas: 0,
  database_create: false,
  definer_execute: 0,
  role_config: EXPECTED_ROLE_CONFIG,
  database_role_config: 0,
};

Deno.test("the session proof accepts only the exact narrow read-only checker", () => {
  requireCheckerSession(narrow);
  assertThrows(() => requireCheckerSession(undefined), CheckError);
  for (const user of ["postgres", "service_role", "still_security_auditor", "authenticated"]) {
    assertThrows(() => requireCheckerSession({ ...narrow, user }), CheckError);
  }
  for (const key of ["superuser", "bypassrls", "createrole", "createdb", "replication", "inherit", "database_create"] as const) {
    assertThrows(() => requireCheckerSession({ ...narrow, [key]: true }), CheckError);
  }
  for (
    const [key, value] of [
      ["memberships", 1],
      ["read_only", "off"],
      ["own_grants", CHECK_VIEWS.length + 1],
      ["own_grants", CHECK_VIEWS.length - 1],
      ["foreign_grants", 1],
      ["writable", 1],
      ["direct_reads", 1],
      ["create_schemas", 1],
      ["definer_execute", 1],
      ["role_config", EXPECTED_ROLE_CONFIG.replace("default_transaction_read_only=on", "default_transaction_read_only=off")],
      ["role_config", `${EXPECTED_ROLE_CONFIG}|search_path=public`],
      ["role_config", ""],
      ["database_role_config", 1],
    ] as const
  ) {
    assertThrows(() => requireCheckerSession({ ...narrow, [key]: value }), CheckError, undefined, `${key}=${value}`);
  }
  // The failure names conditions, never values.
  assertEquals(sessionProblems({ ...narrow, definer_execute: 3, writable: 2 }), ["writable-relation", "definer-execute"]);
});

Deno.test("before migrations 0025 and 0030 the role holds the candidate views only; checks still run, PROD-01 and PROD-02 refuse", () => {
  const migrationViews = Object.keys(MIGRATION_VIEWS).length;
  const before = { ...narrow, own_grants: CHECK_VIEWS.length - migrationViews, migration_grants: "" };
  requireCheckerSession(before);
  assertEquals(grantedMigrationViews(before), []);
  assertEquals(grantedMigrationViews(narrow), ["production_sales_summary", "production_purchase_operations_recent"]);
  // Hosted production between the two applies: 0025's view only.
  const only0025 = { ...narrow, own_grants: CHECK_VIEWS.length - 1, migration_grants: "production_sales_summary" };
  requireCheckerSession(only0025);
  requireMigrationViews("PROD-01", ["production_sales_summary"], only0025);
  const pending = assertThrows(() => requireMigrationViews("PROD-02", ["production_purchase_operations_recent"], only0025), CheckError);
  assert(pending.message.includes("migration 0030"), pending.message);
  // The count must match the reported migration grants exactly, in both directions.
  for (const session of [
    { ...narrow, own_grants: CHECK_VIEWS.length - 1 },
    { ...before, own_grants: CHECK_VIEWS.length },
    { ...only0025, own_grants: CHECK_VIEWS.length },
    { ...narrow, migration_grants: "production_sales_summary,production_sales_summary", own_grants: CHECK_VIEWS.length + 1 },
    { ...narrow, migration_grants: "qa_accounts" },
    { ...narrow, migration_grants: undefined as unknown as string },
  ]) {
    assertEquals(sessionProblems(session), ["grants"], JSON.stringify(session));
  }
  requireMigrationViews("PROD-01", ["production_sales_summary"], narrow);
  requireMigrationViews("PROD-02", ["production_purchase_operations_recent"], narrow);
  requireMigrationViews("DB-31", ["policy_heads", "isolation_summary"], before);
  const error = assertThrows(() => requireMigrationViews("PROD-01", ["production_sales_summary"], before), CheckError);
  assert(error.message.includes("migration 0025"), error.message);
  assert(error.message.includes("Nothing was read"), error.message);
});

Deno.test("production is compared only as a keyed digest", () => {
  const key = "11".repeat(32);
  const rows = [[{ rights: 3n, fingerprint: "a".repeat(32) }], [{ namespace: "sales", newest: 2 }], [{ cutoffs: 0 }]];
  const digest = productionDigest(rows, key);
  assert(/^[0-9a-f]{64}$/.test(digest));
  assert(!digest.includes("a".repeat(16)));
  assertNotEquals(productionDigest(rows, "22".repeat(32)), digest);
  assertEquals(compareProduction(digest, JSON.stringify({ v: 1, digest })), "unchanged");
  assertEquals(compareProduction(digest, JSON.stringify({ v: 1, digest: "0".repeat(64) })), "changed");
  assertEquals(compareProduction(digest, undefined), "no-baseline");
  for (const bad of ["", "not json", "null", "[]", JSON.stringify({ v: 2, digest }), JSON.stringify({ v: 1, digest: "x" }),
    JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, digest: digest.toUpperCase() }), JSON.stringify({ v: "1", digest })]) {
    assertEquals(compareProduction(digest, bad), "baseline-invalid", bad);
  }
  assertThrows(() => productionDigest(rows, "short"), CheckError);
});

Deno.test("a present but malformed baseline fails DB-31 and DB-35 with a named reason", () => {
  // Rows that would otherwise pass DB-31's isolation counts, so only the baseline decides.
  const run = (rows: Record<string, unknown>[][]) =>
    ({ holders: [], results: rows.map((r) => ({ query: {}, rows: r })) }) as unknown as Parameters<typeof verdictFor>[1];
  const db31 = resolveRequest({ check: "DB-31" });
  const db35 = resolveRequest({ check: "DB-35" });
  const clean = run([[], [{ a: 0, b: 0, c: 0 }], []]);
  assertEquals(verdictFor(db31, clean, "baseline-invalid"), "fail");
  assertEquals(verdictFor(db35, run([]), "baseline-invalid"), "fail");
  assertEquals(verdictFor(db31, clean, "no-baseline"), "needs-review", "a missing file stays distinct (the workflow refuses it first)");
  assertEquals(verdictFor(db31, clean, "unchanged"), "pass");
  assert(PRODUCTION_FAILURES["baseline-invalid"]!.startsWith("baseline-invalid: "));
  assertEquals(PRODUCTION_FAILURES["no-baseline"], undefined);
});

Deno.test("failures are described without driver text, hosts or values", () => {
  const leaky = Object.assign(new Error("password authentication failed for db.example.supabase.co user x@y"), {
    code: "28P01",
  });
  assertEquals(describeFailure(leaky), "The database refused the read (SQLSTATE 28P01); nothing was changed.");
  const network = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" });
  assert(!describeFailure(network).includes("10.0.0.1"));
});

const ageBin = Deno.env.get("STILL_QA_AGE_BIN");
const ageKeygen = Deno.env.get("STILL_QA_AGE_KEYGEN");
Deno.test({
  name: "the report is encrypted to the approved recipient and only its private key decrypts it",
  ignore: !ageBin || !ageKeygen,
  async fn() {
    const dir = await Deno.makeTempDir();
    try {
      await new Deno.Command(ageKeygen!, { args: ["-o", `${dir}/key.txt`], stdout: "null", stderr: "null" }).output();
      const key = await Deno.readTextFile(`${dir}/key.txt`);
      const recipient = /public key: (age1[0-9a-z]+)/.exec(key)![1];
      const report = "## Read-only QA check DB-07\n| status |\n| session_bound |\n";
      await encryptReport(report, { ageBin: ageBin!, recipient, outFile: `${dir}/report.age` });
      const sealed = await Deno.readFile(`${dir}/report.age`);
      assert(!new TextDecoder().decode(sealed).includes("session_bound"));
      const opened = await new Deno.Command(ageBin!, {
        args: ["--decrypt", "--identity", `${dir}/key.txt`, `${dir}/report.age`],
        stdout: "piped",
        stderr: "null",
      }).output();
      assertEquals(new TextDecoder().decode(opened.stdout), report);
      await assertRejects(
        () => encryptReport(report, { ageBin: ageBin!, recipient: "age1notvalid", outFile: `${dir}/x.age` }),
        CheckError,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
