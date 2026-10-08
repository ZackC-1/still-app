import { describe, expect, it, vi } from "vitest";
import { NativeBridge } from "../../native/bridge.js";
import type { StillBridgeWindow } from "../../storage/wkwebview-adapter.js";
import { createAppleConsentStore } from "../apple-consent-store.js";
import {
  CONSENT_KEY,
  createStoredConsent,
  readAnalyticsPermission,
  type AnalyticsPermission,
} from "../consent.js";

const VERSION = "a".repeat(64);
const permission = (): AnalyticsPermission => ({
  schemaVersion: 1,
  state: "granted",
  version: VERSION,
  origin: "00000000-0000-4000-8000-000000000001",
  generation: 1,
  provider: {
    anonymousId: "00000000-0000-4000-8000-000000000002",
    deviceId: "00000000-0000-4000-8000-000000000003",
  },
  purposes: { usage: true, email: true, ai: true },
});
function host(
  postMessage: (message: Record<string, unknown>) => Promise<unknown>,
) {
  const port = { postMessage: vi.fn(postMessage) };
  const win: StillBridgeWindow = {
    webkit: { messageHandlers: { still: port } },
  };
  return { win, port, bridge: new NativeBridge(win) };
}

describe("shared Apple combined consent storage", () => {
  it("observes old/unasked native consent without identity creation or a write", async () => {
    const h = host(async () => ({ ok: true, permission: null }));
    const consent = createStoredConsent(
      createAppleConsentStore(h.bridge),
      true,
    );
    expect(await consent.get()).toBe(false);
    expect(h.port.postMessage.mock.calls).toEqual([
      [{ kind: "analyticsPermission" }],
    ]);
  });

  it("uses the existing authority for fresh grant, stop tombstone and cleanup-owned reenable", async () => {
    let stored: AnalyticsPermission | null = null;
    const h = host(async (message) => {
      if (message.kind === "commitAnalyticsPermission")
        stored = readAnalyticsPermission(message.permission);
      return { ok: true, permission: stored };
    });
    const store = createAppleConsentStore(h.bridge);
    const consent = createStoredConsent(store, false);
    await consent.grant(VERSION);
    const granted = (await store.get(CONSENT_KEY)) as AnalyticsPermission;
    expect(granted).toMatchObject({
      state: "granted",
      version: VERSION,
      generation: 1,
    });
    expect(granted.provider.anonymousId).not.toBe(granted.provider.deviceId);
    await consent.set(false);
    expect(await store.get(CONSENT_KEY)).toMatchObject({
      state: "stopped",
      origin: granted.origin,
      generation: 2,
    });
    await expect(consent.grant(VERSION)).rejects.toThrow("cleanup is pending");
    const cleanupOwned = vi.fn(async () => true);
    const renewed = createStoredConsent(store, false, { cleanupOwned });
    await renewed.grant(VERSION);
    const next = (await store.get(CONSENT_KEY)) as AnalyticsPermission;
    expect(next.generation).toBe(3);
    expect(next.origin).not.toBe(granted.origin);
    expect(cleanupOwned).toHaveBeenCalledWith(granted.origin);
  });

  it("preserves an Off choice without optional identities, and requires conclusive Off readback", async () => {
    let stored: false | null = null;
    const h = host(async (message) => {
      if (message.kind === "commitAnalyticsPermission" && message.permission === false) stored = false;
      return { ok: true, permission: stored };
    });
    const store = createAppleConsentStore(h.bridge);
    await createStoredConsent(store, false).set(false);
    expect(await store.get(CONSENT_KEY)).toBe(false);
    expect(h.port.postMessage.mock.calls.every(([message]) => message.kind !== "analyticsContext")).toBe(true);
    const unconfirmed = host(async () => ({ ok: true, permission: null }));
    expect(await unconfirmed.bridge.commitAnalyticsPermission(false)).toBe(false);
  });

  it("does not treat a missing native host as an empty writable permission", async () => {
    const store = createAppleConsentStore(new NativeBridge({}));
    await expect(store.get(CONSENT_KEY)).rejects.toThrow("could not be read");
    await expect(
      createStoredConsent(store, false).grant(VERSION),
    ).rejects.toThrow("could not be read");
    await expect(store.set(CONSENT_KEY, permission())).rejects.toThrow(
      "could not be saved",
    );
  });

  it("refuses legacy true, unrelated storage keys and malformed successful native replies", async () => {
    const h = host(async () => ({
      ok: true,
      permission: { ...permission(), purposes: { usage: true, email: true } },
    }));
    const store = createAppleConsentStore(h.bridge);
    await expect(store.set(CONSENT_KEY, true)).rejects.toThrow(
      "Invalid combined permission",
    );
    await expect(store.get("settings")).rejects.toThrow("Unsupported");
    await expect(store.get(CONSENT_KEY)).rejects.toThrow("could not be read");
    await expect(store.set(CONSENT_KEY, permission())).rejects.toThrow(
      "could not be saved",
    );
  });

  it("requires exact committed readback, including permission generation", async () => {
    const h = host(async () => ({
      ok: true,
      permission: { ...permission(), generation: 2 },
    }));
    expect(await h.bridge.commitAnalyticsPermission(permission())).toBe(false);
    expect(await h.bridge.commitAnalyticsPermission(false)).toBe(false);
  });

  it("rejects a delayed read or write after a native port replacement", async () => {
    let finish!: (result: unknown) => void;
    const h = host(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const read = h.bridge.observeAnalyticsPermission();
    h.win.webkit!.messageHandlers!.still = {
      postMessage: async () => ({ ok: true, permission: null }),
    };
    finish({ ok: true, permission: permission() });
    expect(await read).toBeNull();
    h.win.webkit!.messageHandlers!.still = h.port;
    const write = h.bridge.commitAnalyticsPermission(permission());
    h.win.webkit!.messageHandlers!.still = {
      postMessage: async () => ({ ok: true, permission: null }),
    };
    finish({ ok: true, permission: permission() });
    expect(await write).toBe(false);
  });

  it("fences a previous native permission read when a new choice starts", async () => {
    let finish!: (result: unknown) => void;
    const h = host((message) =>
      message.kind === "analyticsPermission"
        ? new Promise((resolve) => {
            finish = resolve;
          })
      : Promise.resolve({ ok: true, permission: false }),
    );
    const old = h.bridge.observeAnalyticsPermission();
    expect(await h.bridge.commitAnalyticsPermission(false)).toBe(true);
    finish({ ok: true, permission: permission() });
    expect(await old).toBeNull();
  });
});
