#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
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

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SURFACES = Object.freeze({
  chrome: "ext-chromium",
  firefox: "ext-chromium",
  safari: "ext-safari",
  "apple-webview": "app-webview",
});

/** No inherited client configuration or debug logging reaches the build loaders. */
export function profileEnvironment(profile, input = process.env) {
  if (!["local", "test"].includes(profile))
    throw new Error("Choose the local or test QA profile");
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
  if (profile === "test") {
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
}) {
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
      paidTierEnabled: false,
    },
    backend: {
      state:
        profile === "test"
          ? "configured-shared-hosted-unverified"
          : "unconfigured",
      accountScope:
        profile === "test" ? "dedicated-test-accounts-required" : "none",
      // Bind the target without exporting a private test endpoint or client key.
      targetSha256: backendUrl
        ? createHash("sha256").update(backendUrl).digest("hex")
        : null,
      reachableFromPhysicalDevice: "unverified",
    },
    trust: {
      buildMode: "production",
      rules: "production-only",
      access: "production-empty-keys",
      sandboxProofAccepted: false,
    },
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

export async function main(args = process.argv.slice(2)) {
  const [profile, surface = "all", ...extra] = args;
  if (
    !["local", "test"].includes(profile) ||
    extra.length ||
    (surface !== "all" && !Object.hasOwn(SURFACES, surface))
  )
    throw new Error(
      "Usage: v3-profile.mjs <local|test> [all|chrome|firefox|safari|apple-webview]",
    );
  const surfaces = surface === "all" ? Object.keys(SURFACES) : [surface];
  const output = join(ROOT, ".output", "v3-qa", profile);
  await mkdir(output, { recursive: true });
  // Invalidate all selected receipts before validation or building. A refused all build cannot
  // leave later surfaces looking as though they passed the current invocation.
  for (const selected of surfaces)
    await rm(join(output, selected, "artifact-manifest.json"), { force: true });
  const env = profileEnvironment(profile);
  const git = (args) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  const revision = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain"]).length > 0;
  const sourceHash = createHash("sha256");
  const sourcePaths = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const path of sourcePaths) {
    // Removed tracked files are represented explicitly in the source fingerprint.
    sourceHash.update(path).update("\0");
    try {
      sourceHash.update(await readFile(join(ROOT, path)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      sourceHash.update("<deleted>");
    }
    sourceHash.update("\0");
  }
  const sourceSha256 = sourceHash.digest("hex");
  const isolatedEnvDir = await mkdtemp(join(output, ".env-empty-"));
  try {
    for (const selected of surfaces) {
      const surfaceDir = join(output, selected);
      await mkdir(surfaceDir, { recursive: true });
      const result = spawnSync(
        process.execPath,
        [join(ROOT, "scripts/qa/v3-worker.mjs"), selected, surfaceDir],
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
      await writeFile(
        join(surfaceDir, "artifact-manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      process.stdout.write(
        `${selected}: ${artifacts.totalBytes} bytes; ${relative(ROOT, surfaceDir)}/artifact-manifest.json\n`,
      );
    }
  } finally {
    await rm(isolatedEnvDir, { recursive: true, force: true });
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
