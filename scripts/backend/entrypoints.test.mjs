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
