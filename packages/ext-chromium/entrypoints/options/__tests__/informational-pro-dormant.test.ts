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

it("compiled off, a configured new-sync page offers no Buy and never asks about checkout", async () => {
  expect(PAID_TIER_ENABLED).toBe(false);
  await browser();
  const original = chrome.runtime.sendMessage.bind(chrome.runtime);
  const messages: { kind?: string; action?: string }[] = [];
  Object.assign(chrome.runtime, { sendMessage: (message: { kind?: string; action?: string }) => { messages.push(message); return original(message); } });
  vi.stubEnv("VITE_SUPABASE_URL", "https://fixture.invalid");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "fixture-public-key");
  vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "true");
  render(OptionsApp);
  await screen.findByRole("button", { name: "YouTube Blocker" });
  await flush();
  expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
  expect(screen.queryByText("The price is shown at checkout.")).toBeNull();
  expect(messages.filter(message => ["checkoutAvailable", "createCheckout", "reconcile", "setCheckoutPending"].includes(String(message.action)))).toEqual([]);
  expect(messages.some(message => message.kind === "observeBenefits")).toBe(false);
});
