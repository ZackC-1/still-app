import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/svelte";
import { PAID_TIER_ENABLED } from "@still/shared-types";
import { browser, flush } from "../../../../core/src/ui/__tests__/committed-popup-host.fixtures.js";
vi.mock("wxt/browser", () => ({ get browser() { return globalThis.chrome; } }));
import OptionsApp from "../OptionsApp.svelte";

beforeAll(async () => { await import("@still/core/ui/v3/ExtensionSettings.svelte"); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("keeps actual atomic options dormant without observing or using a legacy paid Boolean", async () => {
  expect(PAID_TIER_ENABLED).toBe(false);
  const f = await browser();
  await chrome.storage.local.set({ "still:entitlement": { entitled: true, updatedAt: Date.now() } });
  const original = chrome.runtime.sendMessage.bind(chrome.runtime);
  const messages: unknown[] = [];
  Object.assign(chrome.runtime, { sendMessage: (message: unknown) => { messages.push(message); return original(message); } });
  vi.stubEnv("VITE_SUPABASE_URL", "");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
  vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "true");
  const saved = structuredClone(f.store);
  render(OptionsApp);
  await screen.findByRole("button", { name: "YouTube Blocker" });
  await flush();
  expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull();
  expect(messages.some(message => (message as { kind?: string }).kind === "observeBenefits")).toBe(false);
  expect(f.store).toEqual(saved);
});
