import { afterEach, describe, expect, it, vi } from "vitest";
import { SAFARI_NATIVE_REPLY_BOUND_MS, sendSafariNativeMessage } from "../safari-native-channel.js";
import { SettingsStorageRecovery } from "../atomic-settings.js";

// ISS-0050: one Safari extension page never overlaps its own native messages. Each test stubs a
// fresh runtime, which is a fresh channel (one channel per runtime object, one per page).

interface Pending { message: Record<string, unknown>; answer(reply: unknown): void; refuse(error: Error): void }

function host() {
  const pending: Pending[] = [];
  let outstanding = 0;
  let peak = 0;
  const sendNativeMessage = vi.fn((_app: string, message: Record<string, unknown>) => {
    outstanding += 1;
    peak = Math.max(peak, outstanding);
    return new Promise<unknown>((resolve, reject) => {
      const done = () => { outstanding -= 1; };
      pending.push({ message, answer: (reply) => { done(); resolve(reply); }, refuse: (error) => { done(); reject(error); } });
    });
  });
  vi.stubGlobal("chrome", { runtime: { sendNativeMessage } });
  return { pending, sendNativeMessage, peak: () => peak };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Safari page native channel (ISS-0050)", () => {
  it("sends at once when nothing is outstanding and returns the host's reply", async () => {
    vi.useFakeTimers();
    const h = host();
    const reply = sendSafariNativeMessage({ kind: "get" });
    // Synchronous: an idle page adds no delay to a single message.
    expect(h.sendNativeMessage).toHaveBeenCalledTimes(1);
    h.pending[0]!.answer({ settings: "" });
    await expect(reply).resolves.toEqual({ settings: "" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("queues later messages in order and never overlaps them", async () => {
    vi.useFakeTimers();
    const h = host();
    const first = sendSafariNativeMessage({ kind: "settingsIntent", n: 1 });
    const second = sendSafariNativeMessage({ kind: "get", n: 2 });
    const third = sendSafariNativeMessage({ kind: "settingsIntent", n: 3 });
    expect(h.sendNativeMessage).toHaveBeenCalledTimes(1);
    h.pending[0]!.answer("one");
    await expect(first).resolves.toBe("one");
    expect(h.sendNativeMessage).toHaveBeenCalledTimes(2);
    h.pending[1]!.answer("two");
    await expect(second).resolves.toBe("two");
    h.pending[2]!.answer("three");
    await expect(third).resolves.toBe("three");
    expect(h.pending.map((p) => p.message.n)).toEqual([1, 2, 3]);
    expect(h.peak()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a refused message is unavailable, sent once, and frees the channel", async () => {
    vi.useFakeTimers();
    const h = host();
    const refused = sendSafariNativeMessage({ kind: "settingsIntent" });
    const next = sendSafariNativeMessage({ kind: "get" });
    h.pending[0]!.refuse(new Error("busy"));
    await expect(refused).rejects.toBeInstanceOf(SettingsStorageRecovery);
    await expect(refused).rejects.toMatchObject({ reason: "native-authority-unavailable" });
    expect(h.sendNativeMessage).toHaveBeenCalledTimes(2);
    h.pending[1]!.answer("ok");
    await expect(next).resolves.toBe("ok");
    expect(h.pending.filter((p) => p.message.kind === "settingsIntent")).toHaveLength(1);
  });

  it("a slow reply is never overlapped; the next message goes as soon as it is answered", async () => {
    vi.useFakeTimers();
    const h = host();
    const slow = sendSafariNativeMessage({ kind: "get", n: 1 });
    const next = sendSafariNativeMessage({ kind: "settingsIntent", n: 2 });
    await vi.advanceTimersByTimeAsync(SAFARI_NATIVE_REPLY_BOUND_MS - 1_000);
    expect(h.sendNativeMessage).toHaveBeenCalledTimes(1);
    h.pending[0]!.answer("late but in time");
    await expect(slow).resolves.toBe("late but in time");
    expect(h.sendNativeMessage).toHaveBeenCalledTimes(2);
    h.pending[1]!.answer("saved");
    await expect(next).resolves.toBe("saved");
    expect(h.peak()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a lost reply frees the channel at the reply bound; the message behind it is then sent once", async () => {
    vi.useFakeTimers();
    const h = host();
    const lost = sendSafariNativeMessage({ kind: "settingsIntent" });
    const lostOutcome = lost.catch((error: unknown) => error);
    const next = sendSafariNativeMessage({ kind: "get" });
    await vi.advanceTimersByTimeAsync(SAFARI_NATIVE_REPLY_BOUND_MS - 1);
    expect(h.sendNativeMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await lostOutcome).toMatchObject({ reason: "native-authority-unavailable" });
    expect(h.sendNativeMessage).toHaveBeenCalledTimes(2);
    h.pending[1]!.answer("fresh");
    await expect(next).resolves.toBe("fresh");
    // A reply that finally arrives late changes nothing and is not resent.
    h.pending[0]!.answer("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sendNativeMessage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hung host never makes a caller wait longer than one turn plus one reply, however many are queued", async () => {
    vi.useFakeTimers();
    const h = host();
    const outcomes = Array.from({ length: 10 }, (_, n) =>
      sendSafariNativeMessage({ kind: "settingsIntent", n }).catch((error: unknown) => error));
    // The host never answers anything. Most callers give up unsent once their turn is overdue.
    await vi.advanceTimersByTimeAsync(SAFARI_NATIVE_REPLY_BOUND_MS + 250);
    expect(h.sendNativeMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SAFARI_NATIVE_REPLY_BOUND_MS);
    const settled = await Promise.all(outcomes);
    expect(settled.every((error) => (error as SettingsStorageRecovery).reason === "native-authority-unavailable")).toBe(true);
    // The first was sent and lost; the second was sent when it counted as lost; the rest were dropped unsent.
    expect(h.sendNativeMessage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a caller that stops waiting before its turn is never sent; one that stops after sending keeps the channel busy", async () => {
    vi.useFakeTimers();
    const h = host();
    const read = new AbortController();
    const first = sendSafariNativeMessage({ kind: "get", n: 1 }, read.signal);
    const firstOutcome = first.catch((error: unknown) => error);
    const queued = new AbortController();
    const dropped = sendSafariNativeMessage({ kind: "get", n: 2 }, queued.signal);
    const droppedOutcome = dropped.catch((error: unknown) => error);
    queued.abort();
    expect(await droppedOutcome).toMatchObject({ reason: "native-authority-unavailable" });
    read.abort();
    expect(await firstOutcome).toMatchObject({ reason: "native-authority-unavailable" });
    // Nothing waits, so nothing keeps a timer.
    expect(vi.getTimerCount()).toBe(0);
    const later = sendSafariNativeMessage({ kind: "settingsIntent", n: 3 });
    // The aborted read is still outstanding at the host, so the intent waits for it.
    expect(h.sendNativeMessage).toHaveBeenCalledTimes(1);
    h.pending[0]!.answer("ignored");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.pending.map((p) => p.message.n)).toEqual([1, 3]);
    h.pending[1]!.answer("saved");
    await expect(later).resolves.toBe("saved");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an already aborted caller sends nothing", async () => {
    const h = host();
    const controller = new AbortController();
    controller.abort();
    await expect(sendSafariNativeMessage({ kind: "get" }, controller.signal)).rejects.toMatchObject({ reason: "native-authority-unavailable" });
    expect(h.sendNativeMessage).not.toHaveBeenCalled();
  });

  it("each page (runtime) has its own channel", async () => {
    const first = host();
    void sendSafariNativeMessage({ kind: "get" });
    const second = host();
    void sendSafariNativeMessage({ kind: "get" });
    expect(first.sendNativeMessage).toHaveBeenCalledTimes(1);
    expect(second.sendNativeMessage).toHaveBeenCalledTimes(1);
  });
});
