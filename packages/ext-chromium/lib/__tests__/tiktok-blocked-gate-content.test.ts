// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://www.tiktok.com/foryou"}
import { afterEach, describe, expect, it, vi } from "vitest";

// The real shipping content script on a TikTok page with TikTok on: a configured 2.x build keeps
// today's in-page block and never asks the background for the blocked page.

const CONFIGURED = { VITE_SUPABASE_URL: "https://project.invalid", VITE_SUPABASE_ANON_KEY: "public-anon-key" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

async function run(env: Record<string, string>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const sent: unknown[] = [];
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  vi.stubGlobal("chrome", {
    storage: { local: { get: vi.fn(async () => ({})) }, onChanged: event() },
    runtime: {
      id: "still",
      getURL: (path: string) => `chrome-extension://still/${path}`,
      sendMessage: vi.fn(async (message: unknown) => {
        sent.push(message);
        return { status: "held" };
      }),
    },
  });
  let definition: { main: () => Promise<void> } | undefined;
  vi.stubGlobal("defineContentScript", (value: typeof definition) => (definition = value));
  document.body.innerHTML = '<div id="tiktok-feed">a tiktok</div>';
  await import("../../entrypoints/content/index.js");
  await definition!.main();
  await vi.waitFor(() => expect(document.getElementById("still-placeholder")).not.toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 20));
  return sent.map((message) => (message as { kind?: string }).kind);
}

describe("content script under the TikTok release gate", () => {
  it("a configured 2.x build keeps the in-page block and never sends still:tiktok-blocked", async () => {
    for (const optIn of ["", "false"]) {
      const kinds = await run({ ...CONFIGURED, VITE_MODERN_SETTINGS_SYNC_ENABLED: optIn });
      expect(kinds).not.toContain("still:tiktok-blocked");
      expect(document.body.textContent).toContain("This site is blocked.");
      expect(document.getElementById("tiktok-feed")).toBeNull();
    }
  });

  it("an unconfigured build asks the background (and falls back to the block when held)", async () => {
    const kinds = await run({ VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" });
    expect(kinds).toContain("still:tiktok-blocked");
    expect(document.body.textContent).toContain("This site is blocked.");
  });
});
