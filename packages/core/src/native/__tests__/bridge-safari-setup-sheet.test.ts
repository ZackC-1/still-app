import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_READ_DEADLINE_MS, presentNativeSafariSetup } from "../bridge.js";
import type { StillBridgeWindow } from "../../storage/wkwebview-adapter.js";

function host(reply: (message: unknown) => unknown) {
  const port = { postMessage: vi.fn(async (message: unknown) => reply(message)) };
  const win: StillBridgeWindow = { webkit: { messageHandlers: { still: port } } };
  return { port, win };
}

/** The router's reply once the sheet is shown (SafariSetupSheet.swift): `{ ok: true }`. */
const shown = () => JSON.stringify({ ok: true });

const active = { isActive: true };

afterEach(() => {
  vi.useRealTimers();
});

describe("presentNativeSafariSetup (ISS-0075)", () => {
  it("posts exactly { kind: presentSafariSetup } and resolves true once native shows the sheet", async () => {
    const { port, win } = host(shown);
    await expect(presentNativeSafariSetup({ win, userActivation: active })).resolves.toBe(true);
    expect(port.postMessage).toHaveBeenCalledOnce();
    const [message] = port.postMessage.mock.calls[0]!;
    expect(message).toStrictEqual({ kind: "presentSafariSetup" });
  });

  it("accepts the reply as an object too", async () => {
    const { win } = host(() => ({ ok: true }));
    await expect(presentNativeSafariSetup({ win, userActivation: active })).resolves.toBe(true);
  });

  it("refuses without user activation where WebKit reports it, and posts nothing", async () => {
    const { port, win } = host(shown);
    await expect(
      presentNativeSafariSetup({ win, userActivation: { isActive: false } }),
    ).resolves.toBe(false);
    await expect(presentNativeSafariSetup({ win, userActivation: {} })).resolves.toBe(false);
    expect(port.postMessage).not.toHaveBeenCalled();
    // Older WebKit (iOS 15 to 16.3) has no userActivation: the tap-only caller is the guard.
    await expect(presentNativeSafariSetup({ win, userActivation: null })).resolves.toBe(true);
  });

  it("reads the page's own activation by default", async () => {
    const { port, win } = host(shown);
    vi.stubGlobal("navigator", { userActivation: { isActive: false } });
    try {
      await expect(presentNativeSafariSetup({ win })).resolves.toBe(false);
      expect(port.postMessage).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is false outside the app", async () => {
    await expect(presentNativeSafariSetup({ win: {}, userActivation: active })).resolves.toBe(
      false,
    );
  });

  it.each<[string, () => unknown]>([
    ["a refusal", () => Promise.reject(new Error("still: safari setup refused (inactive)"))],
    ["not shown", () => Promise.reject(new Error("still: safari setup not shown"))],
    ["an empty reply", () => ""],
    ["ok false", () => JSON.stringify({ ok: false })],
    ["ok as a string", () => JSON.stringify({ ok: "true" })],
    ["an array", () => JSON.stringify([{ ok: true }])],
  ])("%s is false", async (_name, reply) => {
    const { win } = host(reply);
    await expect(presentNativeSafariSetup({ win, userActivation: active })).resolves.toBe(false);
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
    const result = presentNativeSafariSetup({ win, userActivation: active });
    await vi.advanceTimersByTimeAsync(NATIVE_READ_DEADLINE_MS);
    await expect(result).resolves.toBe(false);
    answer(shown());
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe(false);
  });
});
