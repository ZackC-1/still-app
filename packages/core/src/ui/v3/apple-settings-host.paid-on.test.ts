// The free-period "Restore purchase" link (owner decision 17) exists only while the compiled paid
// flag is off. PAID_TIER_ENABLED is a literal in shared-types, so this file replaces that one
// export before the modules under test load (as entitlement/__tests__/paid-tier-switch.test.ts
// does) and checks that, with paid on and no paid producer supplied, the D04 screen shows nothing
// in its place and never sends a native restore.
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { resolve } from "node:path";
import type { Component } from "svelte";

vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import { DEFAULT_SETTINGS, PAID_TIER_ENABLED, type StillSettings } from "@still/shared-types";
import { AtomicSettingsWriter, requireModernSettings } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { WKWebViewStorageAdapter, type StillBridgeWindow } from "../../storage/wkwebview-adapter.js";
import { NativeBridge } from "../../native/bridge.js";
import { UiController, type UiAnalytics } from "../controller.svelte.js";
import AppleSettings from "./AppleSettings.svelte";
import {
  appleSettingsCacheOptions,
  appleSettingsHelp,
  createAppleSettingsAuthority,
} from "./apple-settings-host.js";

const HOST_PATH = resolve(import.meta.dirname, "../../../../app-webview/src/AppleSettingsHost.svelte");
const SAVED: StillSettings = { ...DEFAULT_SETTINGS, updatedAt: 21 };

type NativeMessage = { kind: string; command?: string; path?: string; value?: boolean; updatedAt?: number };

/** The TS atomic writer behind the WK message shapes; every other kind is recorded and answered. */
async function compose() {
  const storage = new InMemoryStorageAdapter(SAVED);
  const writer = new AtomicSettingsWriter(storage);
  const messages: NativeMessage[] = [];
  const postMessage = vi.fn(async (message: NativeMessage): Promise<unknown> => {
    messages.push(message);
    switch (message.kind) {
      case "get":
        return (await storage.get()) ?? "";
      case "settingsAtomic": {
        const command = JSON.parse(message.command!) as { action: string; ownership?: "unknown" };
        return command.action === "initialize" ? writer.initialize(command.ownership!) : null;
      }
      case "restore":
        return JSON.stringify({ entitled: true });
      default:
        return null;
    }
  });
  const win: StillBridgeWindow = { webkit: { messageHandlers: { still: { postMessage } } } };
  const adapter = new WKWebViewStorageAdapter(win);
  const cache = new SettingsCache(adapter, appleSettingsCacheOptions("atomic"));
  cache.watch();
  const hydrated = cache.hydrate().catch(() => {});
  const bridge = new NativeBridge(win);
  const authority = createAppleSettingsAuthority(cache, {
    native: bridge,
    initializer: adapter,
    hydration: cache.whenHydrated(),
  });
  const analytics: UiAnalytics = {
    track: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    sharing: async () => ({ enabled: true, noticeNeeded: false }),
    setSharing: vi.fn(async (next: boolean) => next),
  };
  const controller = new UiController({ cache, host: { canPurchase: true }, analytics });
  return { messages, authority, controller, bridge, hydrated, cache };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("paid flag on, no paid producer (the free-period Restore link is withheld)", () => {
  it("the switch is really on in this file", () => {
    expect(PAID_TIER_ENABLED).toBe(true);
  });

  it("D04 host: no Restore purchase link, and no native restore is ever sent", async () => {
    const f = await compose();
    await f.hydrated;
    const { default: Host } = (await import(/* @vite-ignore */ HOST_PATH)) as {
      default: Component<Record<string, unknown>>;
    };
    render(Host, {
      props: {
        controller: f.controller,
        authority: f.authority,
        observeSetup: async () => null,
        help: appleSettingsHelp(vi.fn()),
        restoreBridge: f.bridge,
      },
    });
    expect(await screen.findByText("Still is active")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore purchase" })).toBeNull();
    expect(screen.queryByText("Get Still Pro")).toBeNull();
    for (const button of screen.getAllByRole("button")) await fireEvent.click(button);
    expect(f.messages.map((m) => m.kind)).not.toContain("restore");
    f.authority.stop();
  }, 60_000);

  it("D04 leaf: a supplied restore action is not rendered without a paid producer", async () => {
    const f = await compose();
    await f.hydrated;
    const onRestore = vi.fn();
    render(AppleSettings, {
      props: {
        platform: "ios",
        settings: requireModernSettings(f.cache.currentRecord()),
        access: f.authority.entitlement.currentAccessSnapshot(),
        onGlobalChange: vi.fn(),
        onServiceChange: vi.fn(),
        onFeatureChange: vi.fn(),
        sync: {},
        onRestore,
        help: {},
      },
    });
    expect(screen.queryByRole("button", { name: "Restore purchase" })).toBeNull();
    expect(onRestore).not.toHaveBeenCalled();
    f.authority.stop();
  });
});
