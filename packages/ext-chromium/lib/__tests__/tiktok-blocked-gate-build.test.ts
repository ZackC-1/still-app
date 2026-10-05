import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { build } from "wxt";

// A real WXT build (the shipping pipeline) into a temporary directory, with marker values for
// build inputs. The TikTok gate reads three named inputs; passing import.meta.env whole would
// inline every VITE_* value into the content script. The content script must carry none of the
// markers; the background carries exactly the values it already used before (PostHog and
// Supabase configuration), never an unreferenced input.

const MARKERS = {
  VITE_POSTHOG_KEY: "__MARK_PH__",
  VITE_POSTHOG_HOST: "__MARK_PH_HOST__",
  VITE_UNREFERENCED_MARKER: "__MARK_UNREF__",
  VITE_SUPABASE_URL: "https://mark-supabase.invalid",
  VITE_SUPABASE_ANON_KEY: "__MARK_ANON__",
  VITE_MODERN_SETTINGS_SYNC_ENABLED: "",
};

let out: string | undefined;
afterAll(async () => {
  vi.unstubAllEnvs();
  if (out) await rm(out, { recursive: true, force: true });
});

describe("TikTok gate build inputs", () => {
  it("the built content script contains no build-input value; the background only what it used before", async () => {
    for (const [name, value] of Object.entries(MARKERS)) vi.stubEnv(name, value);
    out = await mkdtemp(join(tmpdir(), "still-tiktok-gate-build-"));
    await build({ root: process.cwd(), outDir: out, browser: "chrome" });
    const content = await readFile(join(out, "chrome-mv3/content-scripts/content.js"), "utf8");
    const background = await readFile(join(out, "chrome-mv3/background.js"), "utf8");
    for (const [name, value] of Object.entries(MARKERS))
      if (value) expect(content.includes(value), `content.js carries ${name}`).toBe(false);
    expect(background.includes(MARKERS.VITE_UNREFERENCED_MARKER), "background.js carries an unreferenced input").toBe(false);
    // The proof is meaningful only if the build really carried the markers somewhere.
    expect(background.includes(MARKERS.VITE_SUPABASE_ANON_KEY)).toBe(true);
  }, 300_000);
});
