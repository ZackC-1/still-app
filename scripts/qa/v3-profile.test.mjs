import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactManifest,
  inventory,
  profileEnvironment,
} from "./v3-profile.mjs";

test("local profile removes inherited client/backend/trust and debug inputs", () => {
  const env = profileEnvironment("local", {
    PATH: "/usr/bin",
    VITE_SUPABASE_URL: "https://production.invalid",
    VITE_SUPABASE_ANON_KEY: "private-sentinel",
    VITE_ACCESS_ENVIRONMENT: "sandbox",
    VITE_ACCESS_KEYS: "sentinel",
    VITE_POSTHOG_KEY: "sentinel",
    STILL_QA_SUPABASE_ANON_KEY: "sentinel",
    DEBUG: "*",
    NODE_OPTIONS: "--require bad",
    NODE_ENV: "development",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    NODE_ENV: "production",
    VITE_MODERN_SETTINGS_SYNC_ENABLED: "true",
    VITE_APPLE_ATOMIC_SETTINGS: "true",
  });
});

const inputs = {
  STILL_QA_BACKEND_ENVIRONMENT: "shared-hosted",
  STILL_QA_SUPABASE_URL: "https://hosted-fixture.invalid",
  STILL_QA_SUPABASE_ANON_KEY: "sb_publishable_test-only",
};
test("test profile requires deliberate paired public configuration and discards unrelated inherited flags", () => {
  assert.throws(() => profileEnvironment("test", {}));
  assert.throws(() =>
    profileEnvironment("test", { ...inputs, STILL_QA_SUPABASE_ANON_KEY: "" }),
  );
  assert.throws(() =>
    profileEnvironment("test", {
      ...inputs,
      STILL_QA_BACKEND_ENVIRONMENT: "production",
    }),
  );
  assert.throws(() =>
    profileEnvironment("test", {
      ...inputs,
      STILL_QA_SUPABASE_URL: "http://remote.invalid",
    }),
  );
  assert.throws(() =>
    profileEnvironment("test", {
      ...inputs,
      STILL_QA_SUPABASE_URL: "https://user:secret@remote.invalid",
    }),
  );
  assert.throws(() =>
    profileEnvironment("test", {
      ...inputs,
      STILL_QA_SUPABASE_ANON_KEY: "sb_secret_private",
    }),
  );
  const jwt = `x.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.x`;
  assert.throws(() =>
    profileEnvironment("test", { ...inputs, STILL_QA_SUPABASE_ANON_KEY: jwt }),
  );
  const env = profileEnvironment("test", {
    ...inputs,
    VITE_POSTHOG_KEY: "private-sentinel",
    VITE_ACCESS_KEYS: "private-sentinel",
  });
  assert.equal(env.VITE_SUPABASE_URL, inputs.STILL_QA_SUPABASE_URL);
  assert.equal(env.VITE_MODERN_SETTINGS_SYNC_ENABLED, "true");
  assert.equal(env.VITE_APPLE_ATOMIC_SETTINGS, "true");
  assert.equal(env.VITE_ACCESS_KEYS, undefined);
  assert.equal(env.VITE_POSTHOG_KEY, undefined);
});

test("manifest binds backend target without exporting endpoint/key or claiming provider readiness", () => {
  const manifest = artifactManifest({
    profile: "test",
    surface: "safari",
    revision: "123",
    dirty: false,
    backendUrl: "https://private-target.invalid",
    artifacts: { totalBytes: 0, files: [] },
  });
  assert.equal(manifest.trust.sandboxProofAccepted, false);
  assert.equal(manifest.trust.buildMode, "production");
  assert.equal(manifest.backend.state, "configured-shared-hosted-unverified");
  assert.equal(
    manifest.backend.accountScope,
    "dedicated-test-accounts-required",
  );
  assert.match(manifest.backend.targetSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /private-target|sb_publishable|sb_secret/,
  );
});

test("artifact inventory records actual bytes/hashes and refuses symlink escape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "still-profile-test-"));
  try {
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "font.woff2"), "abc");
    const result = await inventory(dir);
    assert.equal(result.totalBytes, 3);
    assert.deepEqual(result.files, [
      {
        path: "assets/font.woff2",
        bytes: 3,
        sha256:
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
    ]);
    await symlink(join(dir, "assets", "font.woff2"), join(dir, "escape"));
    await assert.rejects(inventory(dir), /symbolic links/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
