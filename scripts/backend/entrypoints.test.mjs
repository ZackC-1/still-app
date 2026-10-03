import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const auditWorkflow = readFileSync(".github/workflows/security-audit.yml", "utf8");
const rehearsal = readFileSync("scripts/backend/rehearse.sh", "utf8");

for (const [name, source, input] of [
  ["audit", auditWorkflow, `
    import { createAuditConnection } from "./scripts/backend/audit.ts";
    for (const port of [":5432", ""]) {
      const sql = createAuditConnection("postgres://synthetic:synthetic@localhost" + port + "/synthetic?sslmode=require");
      await sql.end();
    }
    console.log("construction passed; no network attempted");
  `],
  ["rehearsal", rehearsal, `
    import postgres from "postgres";
    const sql = postgres("postgres://synthetic:synthetic@localhost:54322/synthetic", {prepare:false, max:1});
    await sql.end();
    console.log("construction passed; no network attempted");
  `],
]) {
  test(`${name} driver initializes under its actual environment permissions`, () => {
    const permission = source.match(/--allow-env=[A-Z_0-9,]+/g);
    assert.equal(permission?.length, 1);
    const result = spawnSync("deno", [
      "run", "--config", "supabase/functions/deno.json", "--no-prompt",
      permission[0], "-",
    ], {
      input,
      encoding: "utf8",
      timeout: 20_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: "/tmp" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "construction passed; no network attempted");
  });
}

for (const phase of ["query", "cleanup"]) {
  test(`audit CLI redacts ${phase} failures and returns nonzero`, () => {
    const temporary = mkdtempSync(join(tmpdir(), "still-audit-cli-"));
    try {
      const stub = join(temporary, "postgres.mjs");
      writeFileSync(stub, `export default function () { return {
        begin: async (_, callback) => {
          if (${JSON.stringify(phase)} === "query") throw new Error("synthetic-credential-sentinel");
          let call = 0;
          const tx = async () => call++ === 0 ? [{user:"still_security_auditor",superuser:false,bypassrls:false,createrole:false,createdb:false,memberships:0}] : [];
          tx.unsafe = async () => [];
          await callback(tx);
        },
        end: async () => { if (${JSON.stringify(phase)} === "cleanup") throw new Error("synthetic-credential-sentinel"); }
      }; }`);
      const importMap = join(temporary, "imports.json");
      writeFileSync(importMap, JSON.stringify({ imports: { postgres: pathToFileURL(stub).href } }));
      // Run the unchanged production entry point; substitute only its I/O dependency.
      const permission = auditWorkflow.match(/--allow-env=[A-Z_0-9,]+/)[0];
      const result = spawnSync("deno", [
        "run", "--no-config", "--no-lock", "--no-prompt", "--import-map", importMap,
        permission, "scripts/backend/audit.ts",
      ], {
        encoding: "utf8", timeout: 20_000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: "/tmp", STILL_SECURITY_AUDIT_DB_URL: "postgres://synthetic:synthetic-credential-sentinel@localhost/synthetic" },
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim(), phase === "query"
        ? "Catalog security audit failed: check the private role/routine/configuration and review catalog drift; keep paid activation held."
        : "Catalog security audit failed: database connection cleanup failed; review the private configuration.");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}


test("settings CLI failure diagnostics expose only bounded whitelist categories", () => {
  const source = readFileSync("scripts/backend/rehearse-settings.sh", "utf8");
  const diagnostics = source.match(/<<'SETTINGS_CLI_DIAGNOSTICS'\n([\s\S]*?)\nSETTINGS_CLI_DIAGNOSTICS/);
  assert(diagnostics, "Missing sanitized CLI failure reporter");
  const temporary = mkdtempSync(join(tmpdir(), "still-settings-diagnostics-"));
  try {
    const log = join(temporary, "serve.log");
    const sentinel = "synthetic-private-credential-sentinel";
    const payload = "worker boot error: Module not found " + sentinel + "\n" +
      "Authorization: Bearer " + sentinel + "\n" +
      "postgresql://user:" + sentinel + "@private.invalid/db\n";
    writeFileSync(log, payload);
    const result = spawnSync("node", ["--input-type=module", "-", log, "false"], {
      input: diagnostics[1], encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert(!result.stdout.includes(sentinel));
    assert.deepEqual(JSON.parse(result.stdout), {
      settingsCliFailure: { running: false, log: "read", truncated: false,
        categories: ["import-resolution", "worker-boot"] },
    });
    writeFileSync(log, "Env name cannot start with SUPABASE_: " + sentinel + "\n" +
      "connection refused: " + sentinel + "\nInvalid JWT " + sentinel);
    const classified = spawnSync("node", ["--input-type=module", "-", log, "true"], {
      input: diagnostics[1], encoding: "utf8", timeout: 5000,
    });
    assert.equal(classified.status, 0, classified.stderr);
    assert.equal(classified.stderr, "");
    assert.deepEqual(JSON.parse(classified.stdout), {
      settingsCliFailure: { running: true, log: "read", truncated: false,
        categories: ["reserved-env", "connection", "jwt-verification"] },
    });
    assert(!classified.stdout.includes(sentinel));
    writeFileSync(log, payload + "x".repeat(70_000));
    const bounded = spawnSync("node", ["--input-type=module", "-", log, "true"], {
      input: diagnostics[1], encoding: "utf8", timeout: 5000,
    });
    assert.equal(bounded.status, 0, bounded.stderr);
    assert.deepEqual(JSON.parse(bounded.stdout), {
      settingsCliFailure: { running: true, log: "read", truncated: true, categories: [] },
    });
    const missing = spawnSync("node", ["--input-type=module", "-", join(temporary, "absent"), "false"], {
      input: diagnostics[1], encoding: "utf8", timeout: 5000,
    });
    assert.equal(missing.status, 0, missing.stderr);
    assert.deepEqual(JSON.parse(missing.stdout), {
      settingsCliFailure: { running: false, log: "unavailable", truncated: false, categories: [] },
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("settings readiness diagnostics reject arbitrary response payloads", () => {
  const result = spawnSync("deno", [
    "test", "--frozen", "--config", "supabase/functions/deno.json", "--no-prompt",
    "--allow-env", "--filter", "readiness diagnostics", "supabase/tests/settings_sync_served_test.ts",
  ], {
    encoding: "utf8", timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: "/tmp" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 passed \| 0 failed/);
  assert(!result.stdout.includes("private-credential-payload-sentinel"));
});
