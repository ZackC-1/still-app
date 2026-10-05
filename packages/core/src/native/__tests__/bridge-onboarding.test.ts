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

describe("NativeBridge analytics consent read-back", () => {
  const context = {
    platform: "ios",
    appVersion: "2.1.0",
    installId: "x",
    anchorId: "y",
    consent: true,
    consentAnswered: true,
  };

  it.each([
    [true, true],
    [false, true],
    [true, false],
  ])(
    "returns consent %s answered %s from object and JSON",
    async (consent, consentAnswered) => {
      for (const raw of [
        { ...context, consent, consentAnswered },
        JSON.stringify({ ...context, consent, consentAnswered }),
      ]) {
        const h = host(raw);
        expect(await h.bridge.observeAnalyticsConsent()).toEqual({
          consent,
          answered: consentAnswered,
        });
        expect(h.port.postMessage.mock.calls).toEqual([
          [{ kind: "analyticsContext" }],
        ]);
      }
    },
  );

  it.each([
    ["missing consent", { ...context, consent: undefined }],
    ["string consent", { ...context, consent: "false" }],
    ["number consent", { ...context, consent: 0 }],
    ["null consent", { ...context, consent: null }],
    ["missing answered (older native)", { ...context, consentAnswered: undefined }],
    ["string answered", { ...context, consentAnswered: "true" }],
    ["array", [{ ...context, consent: false }]],
    ["null", null],
    ["empty", ""],
    ["malformed JSON", "{"],
  ])("is null, never off or answered, for %s", async (_label, reply) => {
    expect(await host(reply).bridge.observeAnalyticsConsent()).toBeNull();
  });

  it("is null without a host, on a failed post, and after a port swap", async () => {
    expect(await new NativeBridge({}).observeAnalyticsConsent()).toBeNull();
    const h = host(context);
    h.port.postMessage.mockRejectedValueOnce(new Error("refused"));
    expect(await h.bridge.observeAnalyticsConsent()).toBeNull();
    const pending = deferred();
    h.port.postMessage.mockReturnValueOnce(pending.promise);
    const read = h.bridge.observeAnalyticsConsent();
    replace(h.win, host(context).port);
    pending.resolve({ ...context, consent: false });
    expect(await read).toBeNull();
  });

  it("a newer read supersedes an older off reply", async () => {
    const pending = deferred();
    const h = host(context);
    h.port.postMessage.mockReturnValueOnce(pending.promise);
    const old = h.bridge.observeAnalyticsConsent();
    expect(await h.bridge.observeAnalyticsConsent()).toEqual({
      consent: true,
      answered: true,
    });
    pending.resolve({ ...context, consent: false });
    expect(await old).toBeNull();
  });
});

describe("NativeBridge analytics consent writer", () => {
  it.each([true, false])(
    "posts the existing setAnalyticsConsent writer and confirms an answered %s",
    async (enabled) => {
      for (const raw of [
        { ok: true, enabled, answered: true },
        JSON.stringify({ ok: true, enabled, answered: true }),
      ]) {
        const h = host(raw);
        expect(await h.bridge.commitAnalyticsConsent(enabled)).toBe(true);
        expect(h.port.postMessage.mock.calls).toEqual([
          [{ kind: "setAnalyticsConsent", enabled }],
        ]);
      }
    },
  );

  it.each([
    ["the default, not an answer", { ok: true, enabled: true, answered: false }],
    ["an older reply without answered", { ok: true, enabled: true }],
    ["a different stored value", { ok: true, enabled: false, answered: true }],
    ["false ok", { ok: false, enabled: true, answered: true }],
    ["truthy ok", { ok: "true", enabled: true, answered: true }],
    ["string answered", { ok: true, enabled: true, answered: "true" }],
    ["array", [{ ok: true, enabled: true, answered: true }]],
    ["null", null],
  ])("is false for %s", async (_label, reply) => {
    expect(await host(reply).bridge.commitAnalyticsConsent(true)).toBe(false);
  });

  it("is false without a host, on refusal, after a port swap and when superseded", async () => {
    expect(await new NativeBridge({}).commitAnalyticsConsent(false)).toBe(false);
    const ok = { ok: true, enabled: false, answered: true };
    const h = host(ok);
    h.port.postMessage.mockRejectedValueOnce(new Error("refused"));
    expect(await h.bridge.commitAnalyticsConsent(false)).toBe(false);
    const swapped = deferred();
    h.port.postMessage.mockReturnValueOnce(swapped.promise);
    const write = h.bridge.commitAnalyticsConsent(false);
    replace(h.win, host(ok).port);
    swapped.resolve(ok);
    expect(await write).toBe(false);
    const h2 = host(ok);
    const older = deferred();
    h2.port.postMessage.mockReturnValueOnce(older.promise);
    const first = h2.bridge.commitAnalyticsConsent(false);
    expect(await h2.bridge.commitAnalyticsConsent(false)).toBe(true);
    older.resolve(ok);
    expect(await first).toBe(false);
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
