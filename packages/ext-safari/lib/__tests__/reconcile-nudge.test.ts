import { describe, expect, it, vi } from "vitest";
import { startSafariReconcileNudges } from "../reconcile-nudge.js";

type Listener = () => void;

function fakeLifecycle() {
  const invalidated: Listener[] = [];
  const listeners: Array<{ target: object; type: string; listener: Listener }> = [];
  const setTimeout = vi.fn();
  const setInterval = vi.fn();

  return {
    lifecycle: {
      setTimeout,
      setInterval,
      addEventListener: (target: object, type: string, listener: Listener) => {
        listeners.push({ target, type, listener });
      },
      onInvalidated: (listener: Listener) => {
        invalidated.push(listener);
        return () => {};
      },
    },
    listeners,
    invalidate: () => invalidated.forEach((listener) => listener()),
  };
}

describe("startSafariReconcileNudges", () => {
  it("owns every nudge timer and listener through the content lifecycle", () => {
    const { lifecycle, listeners, invalidate } = fakeLifecycle();
    const send = vi.fn(() => Promise.resolve());
    const script = { stop: vi.fn() };
    const win = {};
    const doc = { visibilityState: "visible" };

    const nudge = startSafariReconcileNudges({ lifecycle, send, script, win, doc });

    expect(send).toHaveBeenCalledTimes(1);
    expect(lifecycle.setTimeout).toHaveBeenCalledWith(expect.any(Function), 500);
    expect(lifecycle.setInterval).toHaveBeenCalledWith(expect.any(Function), 15_000);
    expect(listeners.map(({ type }) => type)).toEqual(["focus", "pageshow", "visibilitychange"]);

    listeners[0]?.listener();
    listeners[1]?.listener();
    listeners[2]?.listener();
    expect(send).toHaveBeenCalledTimes(4);
    lifecycle.setTimeout.mock.calls[0]?.[0]();
    lifecycle.setInterval.mock.calls[0]?.[0]();
    expect(send).toHaveBeenCalledTimes(6);

    doc.visibilityState = "hidden";
    listeners[2]?.listener();
    lifecycle.setInterval.mock.calls[0]?.[0]();
    expect(send).toHaveBeenCalledTimes(6);

    invalidate();
    expect(script.stop).toHaveBeenCalledTimes(1);
    lifecycle.setTimeout.mock.calls[0]?.[0]();
    lifecycle.setInterval.mock.calls[0]?.[0]();
    listeners.forEach(({ listener }) => listener());
    nudge.request(); // script.start() may resolve after invalidation.
    expect(send).toHaveBeenCalledTimes(6);
  });

  it("contains a failed best-effort nudge", async () => {
    const { lifecycle } = fakeLifecycle();
    const send = vi.fn(() => Promise.reject(new Error("background unavailable")));

    expect(() => startSafariReconcileNudges({
      lifecycle,
      send,
      script: { stop: vi.fn() },
      win: {},
      doc: { visibilityState: "visible" },
    })).not.toThrow();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
