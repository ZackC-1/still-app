// Only creates a disposable fixture tree after the shell's hosted-runner guard.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { settingsRuntimeSources } from "./plan.mjs";
import { randomUUID, generateKeyPairSync } from "node:crypto";
export async function prepareAccessFixture(root, target, envFile, stateFile) {
  await mkdir(join(target, "supabase"), { recursive: true });
  await cp(
    join(root, "supabase/config.toml"),
    join(target, "supabase/config.toml"),
  );
  await cp(
    join(root, "supabase/functions"),
    join(target, "supabase/functions"),
    {
      recursive: true,
      filter: (path) =>
        !path
          .split("/")
          .some(
            (name) =>
              name === "node_modules" ||
              name === ".env" ||
              name.startsWith(".env."),
          ),
    },
  );
  // Serve walks all enabled functions before startup; the policy routes use a
  // shared source deliberately absent from the settings runtime barrel.
  for (const path of [
    ...settingsRuntimeSources,
    "packages/shared-types/src/product-policy.ts",
  ]) {
    await mkdir(join(target, path, ".."), { recursive: true });
    await cp(join(root, path), join(target, path));
  }
  const shared = join(target, "supabase/functions/_shared");
  for (const [fixture, source] of [
    ["apple", "apple-access"],
    ["revenuecat", "revenuecat-access"],
    ["legacy", "revenuecat"],
  ]) {
    const text = (
      await readFile(
        join(root, `supabase/tests/fixtures/access-served-${fixture}.ts`),
        "utf8",
      )
    ).replaceAll(
      `../../functions/_shared/${source}.ts`,
      `./${source}.actual.ts`,
    );
    await cp(join(shared, `${source}.ts`), join(shared, `${source}.actual.ts`));
    await writeFile(join(shared, `access-rehearsal-${fixture}.ts`), text);
  }
  for (const name of [
    "verify-apple-access",
    "link-apple-access",
    "reconcile-entitlement",
  ]) {
    const path = join(target, `supabase/functions/${name}/deno.json`);
    const config = JSON.parse(await readFile(path, "utf8"));
    for (const [source, fixture] of [
      ["apple-access", "apple"],
      ["revenuecat-access", "revenuecat"],
      ["revenuecat", "legacy"],
    ]) {
      for (const prefix of ["./", "../_shared/"])
        config.imports[`${prefix}${source}.ts`] =
          `../_shared/access-rehearsal-${fixture}.ts`;
    }
    await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  const instance = randomUUID();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateBytes = privateKey.export({ format: "der", type: "pkcs8" });
  const publicHex = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  const kid = `access-rehearsal-${instance}`;
  const env = [
    "ENTITLEMENT_WRITER_DB_URL=postgresql://still_entitlement_writer:access-synthetic-writer-only@db:5432/postgres",
    "ACCESS_PROOF_ENVIRONMENT=sandbox",
    `ACCESS_PROOF_KEY_ID=${kid}`,
    `ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64=${privateBytes.toString("base64")}`,
    `ACCESS_PROOF_PUBLIC_KEY_HEX=${publicHex}`,
    `STILL_ACCESS_REHEARSAL_INSTANCE=${instance}`,
    "REVENUECAT_PROJECT_ID=synthetic-project",
    "REVENUECAT_ACCESS_SECRET_API_KEY=synthetic-no-provider-key",
    'ACCESS_PROVIDER_PRODUCTS_JSON=[{"product_id":"synthetic-product","app_id":"synthetic-app","store_identifier":"still_pro_v3","entitlement_lookup_key":"still_pro_v3","store":"rc_billing"}]',
  ];
  await writeFile(envFile, env.join("\n") + "\n", { mode: 0o600 });
  // Public verification material only, used to distinguish the exact new worker from old runtime.
  await writeFile(stateFile, JSON.stringify({ instance, kid, publicHex }), {
    mode: 0o600,
  });
}
if (process.argv[1]?.endsWith("prepare-access-fixture.mjs")) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.platform !== "linux"
  )
    throw new Error("hosted-runner-required");
  await prepareAccessFixture(process.cwd(), ...process.argv.slice(2));
}
