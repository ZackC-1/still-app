import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlan, verifyPlan } from "./plan.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "still-backend-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "supabase/migrations"), { recursive: true });
  await mkdir(join(root, "supabase/functions/demo"), { recursive: true });
  await mkdir(join(root, "scripts/backend/sql"), { recursive: true });
  await writeFile(
    join(root, "supabase/migrations/0001_init.sql"),
    "select 1;\n",
  );
  await writeFile(
    join(root, "supabase/functions/demo/index.ts"),
    'Deno.serve(() => new Response("ok"));\n',
  );
  await writeFile(
    join(root, "supabase/config.toml"),
    "[functions.demo]\nverify_jwt = true\n",
  );
  await writeFile(
    join(root, "scripts/backend/sql/hardening-candidate.sql"),
    "select 2;\n",
  );
  await mkdir(join(root, "supabase/tests"), { recursive: true });
  await mkdir(join(root, ".github/workflows"), { recursive: true });
  await writeFile(join(root, "supabase/tests/security_test.ts"), "// test\n");
  await writeFile(
    join(root, ".github/workflows/supabase-security-rehearsal.yml"),
    "// rehearsal\n",
  );
  await writeFile(
    join(root, ".github/workflows/security-audit.yml"),
    "// audit\n",
  );
  return root;
}
const revision = "a".repeat(40);
const target = "synthetic-github-runner";

test("plan binds actual bytes, target, revision and operation scope", async (t) => {
  const root = await fixture(t);
  const plan = await createPlan(root, { revision, target });
  assert.equal(plan.kind, "rehearsal");
  assert.equal(plan.productionApplyAvailable, false);
  assert.deepEqual(plan.migrations.map((m) => m.id), ["0001"]);
  assert.equal(plan.files.length, 7);
  await verifyPlan(root, plan, { revision, target, digest: plan.digest });
  await assert.rejects(
    verifyPlan(root, plan, {
      revision,
      target: "changed-target",
      digest: plan.digest,
    }),
  );
  await assert.rejects(
    verifyPlan(root, plan, {
      revision: "b".repeat(40),
      target,
      digest: plan.digest,
    }),
  );
  await assert.rejects(
    verifyPlan(root, plan, { revision, target, digest: "0".repeat(64) }),
  );
});

test("a changed source, missing file or new file invalidates the plan", async (t) => {
  const root = await fixture(t);
  const plan = await createPlan(root, { revision, target });
  await writeFile(
    join(root, "supabase/functions/demo/index.ts"),
    "// changed\n",
  );
  await assert.rejects(
    verifyPlan(root, plan, { revision, target, digest: plan.digest }),
  );
  await writeFile(
    join(root, "supabase/functions/demo/index.ts"),
    'Deno.serve(() => new Response("ok"));\n',
  );
  await writeFile(
    join(root, "supabase/migrations/0002_new.sql"),
    "select 3;\n",
  );
  await assert.rejects(
    verifyPlan(root, plan, { revision, target, digest: plan.digest }),
  );
  await rm(join(root, "supabase/migrations/0002_new.sql"));
  await rm(join(root, "supabase/config.toml"));
  await assert.rejects(
    verifyPlan(root, plan, { revision, target, digest: plan.digest }),
  );
});

test("duplicate migration IDs and symlinked inputs are rejected", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "supabase/migrations/0001_collision.sql"),
    "select 4;\n",
  );
  await assert.rejects(createPlan(root, { revision, target }));
  await rm(join(root, "supabase/migrations/0001_collision.sql"));
  await symlink("/etc/hosts", join(root, "supabase/functions/demo/escape.ts"));
  await assert.rejects(createPlan(root, { revision, target }));
});

test("tampered operations or digest never verify, and production target is unavailable", async (t) => {
  const root = await fixture(t);
  const plan = await createPlan(root, { revision, target });
  await assert.rejects(
    verifyPlan(root, { ...plan, productionApplyAvailable: true }, {
      revision,
      target,
      digest: plan.digest,
    }),
  );
  await assert.rejects(createPlan(root, { revision, target: "production" }));
});
