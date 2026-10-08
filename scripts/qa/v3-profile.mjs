#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPLE_TARGETS, assertPaidBuild, sandboxConfiguration, isolatedSandboxSource,
  candidateIdentity, requireIntegratedPaidCandidate, runChecked, buildAppleTarget,
  sourceSnapshot,
  assertCompiledSandboxTrust,
  assertFreePaidFlags,
} from "../../apps/apple/scripts/paid-sandbox-qa.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PAID_INSTALL_ARGS = Object.freeze(["install", "--frozen-lockfile", "--prod=false"]);
export const SURFACES = Object.freeze({
  chrome: "ext-chromium",
  firefox: "ext-chromium",
  safari: "ext-safari",
  "apple-webview": "app-webview",
});

/** No inherited client configuration or debug logging reaches the build loaders. */
export function profileEnvironment(profile, input = process.env) {
  if (!["local", "test", "paid-sandbox"].includes(profile))
    throw new Error("Choose the local, test or paid-sandbox QA profile");
  const env = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) =>
        !key.startsWith("VITE_") &&
        !key.startsWith("STILL_QA_") &&
        !["DEBUG", "NODE_DEBUG", "NODE_OPTIONS"].includes(key),
    ),
  );
  env.NODE_ENV = "production";
  env.VITE_MODERN_SETTINGS_SYNC_ENABLED = "true";
  env.VITE_APPLE_ATOMIC_SETTINGS = "true";
  if (profile === "test" || profile === "paid-sandbox") {
    if (input.STILL_QA_BACKEND_ENVIRONMENT !== "shared-hosted")
      throw new Error(
        "Test builds require STILL_QA_BACKEND_ENVIRONMENT=shared-hosted for the approved hosted backend with dedicated test accounts",
      );
    let url;
    try {
      url = new URL(input.STILL_QA_SUPABASE_URL);
    } catch {
      throw new Error("Test builds require a valid STILL_QA_SUPABASE_URL");
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.protocol !== "https:"
    )
      throw new Error(
        "Hosted backend must be HTTPS without credentials, query, or path",
      );
    const key = input.STILL_QA_SUPABASE_ANON_KEY?.trim();
    if (!key) throw new Error("Test builds require STILL_QA_SUPABASE_ANON_KEY");
    // A service-role/secret key must never be compiled into a client. Legacy JWTs expose role.
    if (key.startsWith("sb_secret_"))
      throw new Error("Only a public Supabase client key is allowed");
    if (key.split(".").length === 3) {
      let claims;
      try {
        claims = JSON.parse(
          Buffer.from(key.split(".")[1], "base64url").toString(),
        );
      } catch {
        throw new Error("Invalid public Supabase client key");
      }
      if (claims.role !== "anon")
        throw new Error(
          "Only an anonymous public Supabase client key is allowed",
        );
    } else if (!key.startsWith("sb_publishable_"))
      throw new Error("Only a public Supabase client key is allowed");
    env.VITE_SUPABASE_URL = url.origin;
    env.VITE_SUPABASE_ANON_KEY = key;
  }
  if (profile === "paid-sandbox") {
    const config = sandboxConfiguration(input);
    // Do not forward provider credentials, bearer tokens or signing paths to clone/build tools.
    const allowed = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_CTYPE", "PNPM_HOME", "CI"]);
    for (const key of Object.keys(env)) if (!allowed.has(key) && !key.startsWith("VITE_") && key !== "NODE_ENV") delete env[key];
    env.VITE_ACCESS_ENVIRONMENT = "sandbox";
    env.VITE_ACCESS_PUBLIC_KEYS = config.publicKeysJson;
  }
  return env;
}

export async function inventory(dir) {
  const files = [];
  async function visit(path) {
    for (const item of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const child = join(path, item.name);
      if (item.isSymbolicLink())
        throw new Error("Artifact inventory refuses symbolic links");
      if (item.isDirectory()) await visit(child);
      else if (item.isFile()) {
        const bytes = await readFile(child);
        files.push({
          path: relative(dir, child).split("\\").join("/"),
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await visit(dir);
  return { totalBytes: files.reduce((n, file) => n + file.bytes, 0), files };
}

export function artifactManifest({
  profile,
  surface,
  revision,
  dirty,
  sourceSha256,
  backendUrl,
  artifacts,
  paidBuild,
}) {
  if (profile === "paid-sandbox") {
    assertPaidBuild(paidBuild);
    if (paidBuild.sourceSha256 !== sourceSha256 || !paidBuild.targets.includes(surface)) throw new Error("Paid sandbox source/target identity mismatch");
  }
  return {
    schema: "still-v3-qa-artifact/v1",
    profile: `v3-${profile}`,
    surface,
    revision,
    dirty,
    sourceSha256,
    runtime: {
      modernSettingsSync: true,
      appleAtomicSettings: true,
      paidTierEnabled: profile === "paid-sandbox",
    },
    backend: {
      state:
        profile !== "local"
          ? "configured-shared-hosted-unverified"
          : "unconfigured",
      accountScope:
        profile !== "local" ? "dedicated-test-accounts-required" : "none",
      // Bind the target without exporting a private test endpoint or client key.
      targetSha256: backendUrl
        ? createHash("sha256").update(backendUrl).digest("hex")
        : null,
      reachableFromPhysicalDevice: "unverified",
    },
    trust: {
      buildMode: "production",
      rules: "production-only",
      access: profile === "paid-sandbox"
        ? surface === "safari" ? "sandbox-native-authority-unverified" : "sandbox-compiled-public-keys"
        : "production-empty-keys",
      sandboxProofAccepted: profile === "paid-sandbox" && surface === "safari" ? null : profile === "paid-sandbox",
      ...(profile === "paid-sandbox" && surface === "safari" ? { nativePackageVerification: "unverified-resource-only" } : {}),
      ...(profile === "paid-sandbox" ? { publicTrustSha256: paidBuild.trustSha256 } : {}),
    },
    ...(profile === "paid-sandbox" ? { paidBuild } : {}),
    tools: { node: process.version },
    artifacts,
    gates: [
      "Real backend account/sync journeys",
      "Scoped sandbox fulfillment and host trust wiring",
      "Managed-only web checkout capability",
      "Native archive/TestFlight and device journeys",
    ],
  };
}

export async function main(args = process.argv.slice(2), input = process.env, root = ROOT, runner = spawnSync) {
  const [profile, surface = "all", ...extra] = args;
  if (
    !["local", "test", "paid-sandbox"].includes(profile) ||
    extra.length ||
    (surface !== "all" && !Object.hasOwn(SURFACES, surface) && !(profile === "paid-sandbox" && (Object.hasOwn(APPLE_TARGETS, surface) || surface === "apple-all")))
  )
    throw new Error(
      "Usage: v3-profile.mjs <local|test|paid-sandbox> [all|chrome|firefox|safari|apple-webview|apple-ios-sim|apple-macos|apple-ios-archive|apple-macos-archive|apple-all]",
    );
  if (profile === "paid-sandbox") return paidSandboxMain(surface, input, root);
  const surfaces = surface === "all" ? Object.keys(SURFACES) : [surface];
  const output = join(root, ".output", "v3-qa", profile);
  await mkdir(output, { recursive: true });
  // Invalidate all selected receipts before validation or building. A refused all build cannot
  // leave later surfaces looking as though they passed the current invocation.
  for (const selected of surfaces)
    await rm(join(output, selected, "artifact-manifest.json"), { force: true });
  const env = profileEnvironment(profile, input);
  // These builds use the current working tree, including HEAD files removed only from the index.
  const { revision, dirty, sha256: sourceSha256, files } = await sourceSnapshot(root, { includeIndexRemovedFiles: true });
  assertFreePaidFlags(files);
  const isolatedEnvDir = await mkdtemp(join(output, ".env-empty-"));
  const pending = [];
  try {
    for (const selected of surfaces) {
      const surfaceDir = join(output, selected);
      await mkdir(surfaceDir, { recursive: true });
      const result = runner(
        process.execPath,
        [join(root, "scripts/qa/v3-worker.mjs"), selected, surfaceDir],
        { cwd: isolatedEnvDir, env, stdio: "inherit" },
      );
      if (result.error || result.status !== 0)
        throw new Error(
          `QA build failed for ${selected}; no manifest was issued`,
        );
      const artifacts = await inventory(join(surfaceDir, "artifact"));
      const manifest = artifactManifest({
        profile,
        surface: selected,
        revision,
        dirty,
        sourceSha256,
        backendUrl: env.VITE_SUPABASE_URL,
        artifacts,
      });
      pending.push({ path: join(surfaceDir, "artifact-manifest.json"), manifest, selected, surfaceDir });
    }
    if ((await sourceSnapshot(root, { includeIndexRemovedFiles: true })).sha256 !== sourceSha256)
      throw new Error("QA source changed during build; no manifest was issued");
    for (const { path, manifest, selected, surfaceDir } of pending) {
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      process.stdout.write(
        `${selected}: ${manifest.artifacts.totalBytes} bytes; ${relative(root, surfaceDir)}/artifact-manifest.json\n`,
      );
    }
  } catch (error) {
    for (const selected of surfaces) await rm(join(output, selected, "artifact-manifest.json"), { force: true });
    throw error;
  } finally {
    await rm(isolatedEnvDir, { recursive: true, force: true });
  }
}


/** All selected targets share one source overlay, public trust fingerprint and build identity. */
export async function paidSandboxMain(surface, input = process.env, root = ROOT) {
  const targets = surface === "apple-all" ? [...Object.keys(SURFACES), "apple-ios-sim", "apple-macos"] :
    surface === "all" ? Object.keys(SURFACES) : Object.hasOwn(APPLE_TARGETS, surface) ? ["safari", "apple-webview", surface] : [surface];
  const output = join(root, ".output/v3-qa/paid-sandbox");
  await mkdir(output, { recursive: true });
  for (const target of targets) await rm(join(output, target, "artifact-manifest.json"), { force: true });
  // Inputs and integration prerequisites are checked before any install/build/compiler operation.
  const env = profileEnvironment("paid-sandbox", input), config = sandboxConfiguration(input);
  await requireIntegratedPaidCandidate(root);
  const pending = [];
  try {
    await isolatedSandboxSource(root, config, async ({ clone, run, snapshot, overlay }) => {
      const identity = candidateIdentity(snapshot, overlay, targets);
      const envDir = join(run, "empty-env"); await mkdir(envDir);
      runChecked("pnpm", PAID_INSTALL_ARGS, { cwd: clone, env });
      for (const target of targets) {
        const targetDir = join(output, target);
        await rm(targetDir, { recursive: true, force: true }); await mkdir(targetDir);
        let nativePackage;
        if (Object.hasOwn(APPLE_TARGETS, target)) {
          nativePackage = await buildAppleTarget({ clone, output: targetDir, target, env, config });
          // The native packager rebuilds dist through existing release commands. Bind those
          // resources to the same run's independently built web-resource receipts too.
          for (const [webTarget, actual] of [["apple-webview", "packages/app-webview/dist"], ["safari", "packages/ext-safari/dist/safari-mv3"]]) {
            const built = await inventory(join(clone, actual));
            const expected = pending.find(item => item.target === webTarget)?.manifest.artifacts;
            const files = built.files.filter(file => file.path !== ".env-state");
            if (!expected || JSON.stringify(files) !== JSON.stringify(expected.files)) throw new Error("Native/web resource build identities differ; receipt refused");
          }
        } else {
          runChecked(process.execPath, [join(clone, "scripts/qa/v3-worker.mjs"), target, targetDir], { cwd: envDir, env });
        }
        const artifacts = await inventory(join(targetDir, "artifact"));
        // Safari delegates benefit verification to its native host; these resources cannot
        // certify that host's trust. Apple targets verify the compiled app/extension plists
        // and bind their resources to this same cohort. The webview verifies proofs in its
        // inline module as well, so keep its JavaScript trust check alongside Chrome/Firefox.
        if (!nativePackage && target !== "safari") await assertCompiledSandboxTrust(join(targetDir, "artifact"), config, { sourceRoot: clone, inlineModules: target === "apple-webview" });
        const manifest = artifactManifest({ profile: "paid-sandbox", surface: target, revision: snapshot.revision, dirty: snapshot.dirty,
          sourceSha256: snapshot.sha256, backendUrl: config.backendUrl, artifacts,
          paidBuild: { ...identity, ...(nativePackage ? { nativePackage } : { nativePackage: "not-built-for-this-surface" }) } });
        pending.push({ target, path: join(targetDir, "artifact-manifest.json"), manifest });
      }
    });
    // Issue receipts only after ALL targets and source preservation checks succeed.
    for (const item of pending) await writeFile(item.path, `${JSON.stringify(item.manifest, null, 2)}\n`);
    process.stdout.write(`Paid sandbox QA: ${targets.length} targets built; common source/trust identity recorded. Provider/device verification remains required.\n`);
  } catch (error) {
    for (const target of targets) await rm(join(output, target, "artifact-manifest.json"), { force: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`V3 QA build: ${error.message}\n`);
    process.exitCode = 1;
  });
}
