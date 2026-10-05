import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_READ_DEADLINE_MS,
  openNativeDestination,
  type NativeOpenDestination,
} from "../bridge.js";
import type { StillBridgeWindow } from "../../storage/wkwebview-adapter.js";

function host(reply: (message: { kind: string; destination?: unknown }) => unknown) {
  const port = {
    postMessage: vi.fn(async (message: unknown) =>
      reply(message as { kind: string; destination?: unknown }),
    ),
  };
  const win: StillBridgeWindow = { webkit: { messageHandlers: { still: port } } };
  return { port, win };
}

/** The router's reply for an accepted open: `{ ok: true, destination }`. */
const opened = (message: { destination?: unknown }) =>
  JSON.stringify({ ok: true, destination: message.destination });

const active = { isActive: true };

afterEach(() => {
  vi.useRealTimers();
});

describe("openNativeDestination", () => {
  it.each(["safariExtensionSettings", "settingsAppStillPage", "safari"] as const)(
    "posts exactly { kind, destination } for %s and resolves true on the native confirmation",
    async (destination) => {
      const { port, win } = host(opened);
      await expect(
        openNativeDestination(destination, { win, userActivation: active }),
      ).resolves.toBe(true);
      expect(port.postMessage).toHaveBeenCalledOnce();
      const [message] = port.postMessage.mock.calls[0]!;
      expect(message).toStrictEqual({ kind: "openDestination", destination });
    },
  );

  it("never posts anything but a fixed destination: a URL from a caller is refused locally", async () => {
    const { port, win } = host(opened);
    for (const forged of [
      "https://evil.example",
      "x-apple.systempreferences:com.apple.preference",
      "App-prefs:root=SAFARI",
      "Safari",
      "",
    ]) {
      await expect(
        openNativeDestination(forged as NativeOpenDestination, { win, userActivation: active }),
      ).resolves.toBe(false);
    }
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it("refuses without user activation where WebKit reports it, and posts nothing", async () => {
    const { port, win } = host(opened);
    await expect(
      openNativeDestination("safari", { win, userActivation: { isActive: false } }),
    ).resolves.toBe(false);
    await expect(
      openNativeDestination("safari", { win, userActivation: {} }),
    ).resolves.toBe(false);
    expect(port.postMessage).not.toHaveBeenCalled();
    // Older WebKit (iOS 15 to 16.3) has no userActivation: the tap-only callers are the guard.
    await expect(openNativeDestination("safari", { win, userActivation: null })).resolves.toBe(true);
  });

  it("reads the page's own activation by default", async () => {
    const { port, win } = host(opened);
    vi.stubGlobal("navigator", { userActivation: { isActive: false } });
    try {
      await expect(openNativeDestination("safari", { win })).resolves.toBe(false);
      expect(port.postMessage).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is false outside the app", async () => {
    await expect(
      openNativeDestination("safari", { win: {}, userActivation: active }),
    ).resolves.toBe(false);
  });

  it.each<[string, () => unknown]>([
    ["a refusal", () => Promise.reject(new Error("still: open refused (inactive)"))],
    ["a failed open", () => Promise.reject(new Error("still: open failed"))],
    ["an empty reply", () => ""],
    ["ok false", () => JSON.stringify({ ok: false, destination: "safari" })],
    ["another destination", () => JSON.stringify({ ok: true, destination: "safariExtensionSettings" })],
    ["no destination", () => JSON.stringify({ ok: true })],
    ["an array", () => JSON.stringify([{ ok: true, destination: "safari" }])],
  ])("%s is false", async (_name, reply) => {
    const { win } = host(reply);
    await expect(
      openNativeDestination("safari", { win, userActivation: active }),
    ).resolves.toBe(false);
  });

  it("a native reply that never comes is false at the deadline, and a late one changes nothing", async () => {
    vi.useFakeTimers();
    let answer!: (reply: unknown) => void;
    const { win } = host(
      () =>
        new Promise<unknown>((resolve) => {
          answer = resolve;
        }),
    );
    const result = openNativeDestination("safari", { win, userActivation: active });
    await vi.advanceTimersByTimeAsync(NATIVE_READ_DEADLINE_MS);
    await expect(result).resolves.toBe(false);
    answer(JSON.stringify({ ok: true, destination: "safari" }));
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe(false);
  });
});
