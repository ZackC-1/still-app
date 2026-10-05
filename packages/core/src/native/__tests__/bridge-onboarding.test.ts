import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundedNativeRead,
  NATIVE_READ_DEADLINE_MS,
  NativeBridge,
} from "../bridge.js";
import type {
  StillBridgeWindow,
  StillMessagePort,
} from "../../storage/wkwebview-adapter.js";

const state = {
  ok: true,
  shouldShow: true,
  platform: "ios",
  osMajorVersion: 18,
};

function host(reply: unknown) {
  const port = { postMessage: vi.fn(async (_message: unknown) => reply) };
  const win: StillBridgeWindow = {
    webkit: { messageHandlers: { still: port } },
  };
  return { port, win, bridge: new NativeBridge(win) };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function replace(win: StillBridgeWindow, port?: StillMessagePort) {
  win.webkit = port ? { messageHandlers: { still: port } } : undefined;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("NativeBridge onboarding state", () => {
  it.each([
    ["ios show", state],
    ["ios hidden", { ...state, shouldShow: false }],
    ["macos", { ...state, platform: "macos", osMajorVersion: 15 }],
    ["older ios", { ...state, osMajorVersion: 15 }],
  ])(
    "accepts %s from object and JSON, posting only a pure read",
    async (_label, reply) => {
      for (const raw of [reply, JSON.stringify(reply)]) {
        const h = host(raw);
        expect(await h.bridge.onboardingState()).toEqual(reply);
        expect(h.port.postMessage.mock.calls).toEqual([
          [{ kind: "onboardingState" }],
        ]);
      }
    },
  );

  it("drops fields the contract does not name", async () => {
    expect(
      await host({ ...state, extra: "x" }).bridge.onboardingState(),
    ).toEqual(state);
  });

  it("returns null without a native host", async () => {
    expect(await new NativeBridge({}).onboardingState()).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["malformed JSON", "{"],
    ["array", [state]],
    ["JSON array", JSON.stringify([state])],
    ["boolean", true],
    ["missing ok", { ...state, ok: undefined }],
    ["false ok", { ...state, ok: false }],
    ["truthy ok", { ...state, ok: "true" }],
    ["missing shouldShow", { ...state, shouldShow: undefined }],
    ["string shouldShow", { ...state, shouldShow: "true" }],
    ["number shouldShow", { ...state, shouldShow: 1 }],
    ["wrong platform", { ...state, platform: "mac" }],
    ["missing platform", { ...state, platform: undefined }],
    ["string version", { ...state, osMajorVersion: "18" }],
    ["fractional version", { ...state, osMajorVersion: 18.5 }],
    ["zero version", { ...state, osMajorVersion: 0 }],
    ["negative version", { ...state, osMajorVersion: -18 }],
    ["NaN version", { ...state, osMajorVersion: Number.NaN }],
    ["missing version", { ...state, osMajorVersion: undefined }],
  ])("rejects %s instead of guessing the gate", async (_label, reply) => {
    expect(await host(reply).bridge.onboardingState()).toBeNull();
  });

  it("returns null when the post rejects or throws", async () => {
    const h = host(state);
    h.port.postMessage.mockRejectedValueOnce(new Error("refused"));
    expect(await h.bridge.onboardingState()).toBeNull();
    h.port.postMessage.mockImplementationOnce(() => {
      throw new Error("port stopped");
    });
    expect(await h.bridge.onboardingState()).toBeNull();
  });

  it.each(["replacement", "disappearance"])(
    "discards a show reply after port %s",
    async (change) => {
      const pending = deferred();
      const h = host(state);
      h.port.postMessage.mockReturnValueOnce(pending.promise);
      const read = h.bridge.onboardingState();
      replace(h.win, change === "replacement" ? host(state).port : undefined);
      pending.resolve(state);
      expect(await read).toBeNull();
    },
  );

  it("a newer read supersedes an older show reply", async () => {
    const pending = deferred();
    const h = host(state);
    h.port.postMessage.mockReturnValueOnce(pending.promise);
    const old = h.bridge.onboardingState();
    h.port.postMessage.mockResolvedValueOnce({ ...state, shouldShow: false });
    expect(await h.bridge.onboardingState()).toEqual({
      ...state,
      shouldShow: false,
    });
    pending.resolve(state);
    expect(await old).toBeNull();
  });
});

describe("NativeBridge onboarding completion", () => {
  it.each([
    ["object", { ok: true }],
    ["JSON", JSON.stringify({ ok: true })],
  ])("is true only for an explicit ok %s", async (_label, reply) => {
    const h = host(reply);
    expect(await h.bridge.completeOnboarding()).toBe(true);
    expect(h.port.postMessage.mock.calls).toEqual([
      [{ kind: "completeOnboarding" }],
    ]);
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["array", [{ ok: true }]],
    ["false ok", { ok: false }],
    ["truthy ok", { ok: "true" }],
    ["missing ok", {}],
  ])("is false for %s", async (_label, reply) => {
    expect(await host(reply).bridge.completeOnboarding()).toBe(false);
  });

  it("is false without a host, on native refusal, and on a throw", async () => {
    expect(await new NativeBridge({}).completeOnboarding()).toBe(false);
    const h = host({ ok: true });
    h.port.postMessage.mockRejectedValueOnce(
      new Error("still: onboarding not presented by the web view"),
    );
    expect(await h.bridge.completeOnboarding()).toBe(false);
    h.port.postMessage.mockImplementationOnce(() => {
      throw new Error("port stopped");
    });
    expect(await h.bridge.completeOnboarding()).toBe(false);
  });

  it("cannot confirm through a swapped port", async () => {
    const pending = deferred();
    const h = host({ ok: true });
    h.port.postMessage.mockReturnValueOnce(pending.promise);
    const write = h.bridge.completeOnboarding();
    replace(h.win, host({ ok: true }).port);
    pending.resolve({ ok: true });
    expect(await write).toBe(false);
  });

  it("an older completion is superseded by a newer one", async () => {
    const pending = deferred();
    const h = host({ ok: true });
    h.port.postMessage.mockReturnValueOnce(pending.promise);
    const old = h.bridge.completeOnboarding();
    expect(await h.bridge.completeOnboarding()).toBe(true);
    pending.resolve({ ok: true });
    expect(await old).toBe(false);
  });
});

describe("boundedNativeRead", () => {
  it("returns the read when it settles before the deadline", async () => {
    expect(await boundedNativeRead(async () => "value", null)).toBe("value");
  });

  it("returns the fallback on rejection or a synchronous throw", async () => {
    expect(
      await boundedNativeRead(() => Promise.reject(new Error("x")), null),
    ).toBeNull();
    expect(
      await boundedNativeRead(() => {
        throw new Error("sync");
      }, false),
    ).toBe(false);
  });

  it("never hangs: a silent host becomes the fallback at the deadline", async () => {
    vi.useFakeTimers();
    const silent = vi.fn(() => new Promise<string>(() => {}));
    const read = boundedNativeRead(silent, null);
    let result: unknown = "pending";
    void read.then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(NATIVE_READ_DEADLINE_MS - 1);
    expect(result).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();
    expect(silent).toHaveBeenCalledOnce();
  });

  it("a late reply after the deadline does not change the result", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const read = boundedNativeRead(() => pending.promise, null, 10);
    await vi.advanceTimersByTimeAsync(10);
    pending.resolve("late");
    expect(await read).toBeNull();
  });

  it("uses a bounded deadline", () => {
    expect(NATIVE_READ_DEADLINE_MS).toBeGreaterThan(0);
    expect(NATIVE_READ_DEADLINE_MS).toBeLessThanOrEqual(5_000);
  });
});
