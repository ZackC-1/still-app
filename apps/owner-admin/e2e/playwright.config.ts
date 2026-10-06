import { defineConfig } from "@playwright/test";

// Smoke test of the BUILT owner page (single file, real CSP) on a local static server. The
// Supabase auth and admin endpoints are mocked by the test; no network leaves the machine.
// The build here uses a made-up local project URL and a made-up anon key, never real config.
const PORT = 4317;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
export const FAKE_ANON_KEY = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase-demo", role: "anon" })}.c21va2UtdGVzdA`;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: ORIGIN, browserName: "chromium" },
  webServer: {
    command: "vite build --outDir e2e/dist && node scripts/bundle-guard.mjs e2e/dist/index.html && node e2e/serve.mjs",
    cwd: "..",
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { VITE_SUPABASE_URL: ORIGIN, VITE_SUPABASE_ANON_KEY: FAKE_ANON_KEY, PORT: String(PORT) },
  },
});
