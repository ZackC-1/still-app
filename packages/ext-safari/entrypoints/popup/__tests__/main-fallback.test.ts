import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// popup/main.ts runs on import. Whatever the V3 attempt does, exactly one popup must start: V3
// when it mounted, otherwise the legacy popup once (never twice, never none).
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function run(options: { flag: string | undefined; modern?: string; configured?: boolean; v3: "legacy" | "v3" | "rejects" | "import-fails" }) {
  vi.resetModules();
  const mount = vi.fn();
  const createController = vi.fn(() => ({}));
  vi.doMock("svelte", () => ({ mount }));
  vi.doMock("@still/core/ui", () => ({ createExtensionUiController: createController }));
  vi.doMock("../PopupApp.svelte", () => ({ default: {} }));
  vi.doMock("../../../lib/account-status.js", () => ({ readAccountStatus: vi.fn() }));
  vi.doMock("../../../lib/native-settings.js", () => ({ pushSettingsToApp: vi.fn() }));
  vi.doMock("../../../lib/analytics.js", () => ({ createSafariPageAnalytics: () => ({}) }));
  const start = vi.fn(async () => {
    if (options.v3 === "rejects") throw new Error("unexpected");
    return options.v3;
  });
  if (options.v3 === "import-fails") {
    vi.doMock("../v3.js", () => {
      throw new Error("chunk failed to load");
    });
  } else {
    vi.doMock("../v3.js", () => ({ startSafariV3Popup: start }));
  }
  vi.stubEnv("VITE_APPLE_ATOMIC_SETTINGS", options.flag as string);
  vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", options.modern as string);
  vi.stubEnv("VITE_SUPABASE_URL", options.configured ? "https://still-audit.invalid" : "");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", options.configured ? "public-audit-placeholder" : "");
  document.body.innerHTML = '<div id="app"></div>';
  await import("../main.js");
  for (let i = 0; i < 10; i++) await flush();
  return { mount, createController, start };
}

beforeEach(() => {
  vi.stubGlobal("browser", { runtime: { sendMessage: vi.fn(async () => undefined) } });
});

afterEach(() => {
  vi.doUnmock("../v3.js");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("popup main: the V3 attempt hands over to the legacy popup exactly once", () => {
  it.each([
    ["the V3 gate says legacy", "legacy" as const],
    ["the V3 gate rejects", "rejects" as const],
    ["the V3 module fails to load", "import-fails" as const],
  ])("%s: one legacy popup", async (_name, v3) => {
    const { mount, createController } = await run({ flag: "true", v3 });
    expect(createController).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it("V3 mounted: the legacy popup does not start", async () => {
    const { mount, createController, start } = await run({ flag: "true", v3: "v3" });
    expect(start).toHaveBeenCalled();
    expect(createController).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
  });

  it("a default build (flag off) starts the legacy popup once and never asks V3", async () => {
    const { mount, createController, start } = await run({ flag: undefined, v3: "v3" });
    expect(start).not.toHaveBeenCalled();
    expect(createController).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it("a configured build with the modern sync flag asks V3, with the flag passed to the rule", async () => {
    const { createController, start } = await run({ flag: undefined, modern: "true", configured: true, v3: "v3" });
    expect(start).toHaveBeenCalledWith({ env: expect.objectContaining({ modernSyncFlag: "true", atomicSettingsFlag: undefined }) });
    expect(createController).not.toHaveBeenCalled();
  });

  it.each([undefined, "TRUE", "1", "false"])("a configured build with the modern flag %s starts the legacy popup and never asks V3", async (modern) => {
    for (const flag of [undefined, "true"]) {
      const { mount, createController, start } = await run({ flag, modern, configured: true, v3: "v3" });
      expect(start).not.toHaveBeenCalled();
      expect(createController).toHaveBeenCalledTimes(1);
      expect(mount).toHaveBeenCalledTimes(1);
    }
  });
});
