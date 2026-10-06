import { describe, expect, it, vi } from "vitest";
import {
  createBrowserSettingsRestore,
  type BrowserRestoreAnswer,
} from "./browser-settings-restore.js";
import type { RestoreStatusCardProps } from "./extension-settings-presentation.js";

// The browser settings page's free-period Restore (owner decisions 62 and 73, option A). The flow
// is a pure state machine: these tests drive it with a fake check, a fake sign-in opener and the
// account facts a host's effect would feed it.

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(answers: (BrowserRestoreAnswer | Error | Promise<BrowserRestoreAnswer>)[] = []) {
  const published: (RestoreStatusCardProps | undefined)[] = [];
  const check = vi.fn(async (): Promise<BrowserRestoreAnswer> => {
    const next = answers.shift();
    if (next === undefined) throw new Error("unexpected check");
    if (next instanceof Error) throw next;
    return next;
  });
  const openSignIn = vi.fn();
  const flow = createBrowserSettingsRestore({
    check,
    openSignIn,
    publish: (restore) => published.push(restore),
  });
  const last = () => published.at(-1);
  const states = () => published.map((card) => card?.state);
  return { flow, check, openSignIn, published, last, states };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("browser settings Restore: signed in", () => {
  it("a past buyer: one check, then restored", async () => {
    const h = harness(["entitled"]);
    h.flow.observe({ userId: "user-a", signInOpen: false });
    h.flow.request();
    expect(h.last()).toEqual({ state: "checking" });
    await settle();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.openSignIn).not.toHaveBeenCalled();
    expect(h.states()).toEqual(["checking", "restored"]);
    expect(h.last()).toEqual({ state: "restored" });
  });

  it("no purchase: one check, then the conclusive nothing state", async () => {
    const h = harness(["not-entitled"]);
    h.flow.observe({ userId: "user-a", signInOpen: false });
    h.flow.request();
    await settle();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.states()).toEqual(["checking", "nothing"]);
  });

  it.each(["unknown", "auth-required", "signed-out"] as const)(
    "an inconclusive answer (%s) is the failed state, never nothing",
    async (answer) => {
      const h = harness([answer]);
      h.flow.observe({ userId: "user-a", signInOpen: false });
      h.flow.request();
      await settle();
      expect(h.last()?.state).toBe("failed");
      expect(h.published.some((card) => card?.state === "nothing")).toBe(false);
    },
  );

  it("an error (the check rejects) is failed, and its Try again runs one fresh check", async () => {
    const h = harness([new Error("transport torn"), "entitled"]);
    h.flow.observe({ userId: "user-a", signInOpen: false });
    h.flow.request();
    await settle();
    const failed = h.last();
    expect(failed?.state).toBe("failed");
    expect(failed?.onAction).toBeTypeOf("function");
    failed!.onAction!();
    failed!.onAction!(); // a double tap on Try again is still one check
    await settle();
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(h.states()).toEqual(["checking", "failed", "checking", "restored"]);
  });

  it("offline (the background could not reach the server) is failed with Try again", async () => {
    const h = harness(["unknown"]);
    h.flow.observe({ userId: "user-a", signInOpen: false });
    h.flow.request();
    await settle();
    expect(h.last()).toMatchObject({ state: "failed" });
    expect(h.last()?.onAction).toBeTypeOf("function");
  });

  it("a double tap while checking runs one check", async () => {
    const pending = deferred<BrowserRestoreAnswer>();
    const h = harness([pending.promise]);
    h.flow.observe({ userId: "user-a", signInOpen: false });
    h.flow.request();
    h.flow.request();
    h.flow.request();
    expect(h.flow.busy).toBe(true);
    pending.resolve("entitled");
    await settle();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.states()).toEqual(["checking", "restored"]);
    expect(h.flow.busy).toBe(false);
    // Once settled, a new tap is a new check.
    h.flow.request();
    expect(h.flow.busy).toBe(true);
  });
});

describe("browser settings Restore: signed out", () => {
  it("opens the normal sign-in first, then runs the check once signed in", async () => {
    const h = harness(["entitled"]);
    h.flow.observe({ userId: null, signInOpen: false });
    h.flow.request();
    expect(h.openSignIn).toHaveBeenCalledTimes(1);
    expect(h.check).not.toHaveBeenCalled();
    expect(h.published).toEqual([]);
    h.flow.observe({ userId: null, signInOpen: true });
    h.flow.request(); // a second tap behind the sheet opens nothing more
    expect(h.openSignIn).toHaveBeenCalledTimes(1);
    // The code verifies: the account appears and the sheet closes in the same step.
    h.flow.observe({ userId: "user-a", signInOpen: false });
    await settle();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.states()).toEqual(["checking", "restored"]);
  });

  it("signed out then no purchase shows nothing found after sign-in", async () => {
    const h = harness(["not-entitled"]);
    h.flow.observe({ userId: null, signInOpen: false });
    h.flow.request();
    h.flow.observe({ userId: null, signInOpen: true });
    h.flow.observe({ userId: "user-a", signInOpen: false });
    await settle();
    expect(h.states()).toEqual(["checking", "nothing"]);
  });

  it("dismissing the sign-in sheet ends the request quietly; no check, nothing shown", async () => {
    const h = harness(["entitled"]);
    h.flow.observe({ userId: null, signInOpen: false });
    h.flow.request();
    h.flow.observe({ userId: null, signInOpen: true });
    h.flow.observe({ userId: null, signInOpen: false });
    expect(h.flow.busy).toBe(false);
    // A later, unrelated sign-in does not run a check nobody asked for.
    h.flow.observe({ userId: "user-a", signInOpen: false });
    await settle();
    expect(h.check).not.toHaveBeenCalled();
    expect(h.published).toEqual([]);
    // Tapping again starts over with the sign-in.
    h.flow.observe({ userId: null, signInOpen: false });
    h.flow.request();
    expect(h.openSignIn).toHaveBeenCalledTimes(2);
  });
});

describe("browser settings Restore: account changes and teardown", () => {
  it("a result that lands after the account changed is dropped, and the card clears", async () => {
    const pending = deferred<BrowserRestoreAnswer>();
    const h = harness([pending.promise]);
    h.flow.observe({ userId: "user-a", signInOpen: false });
    h.flow.request();
    h.flow.observe({ userId: null, signInOpen: false }); // signed out mid-check
    pending.resolve("entitled");
    await settle();
    expect(h.states()).toEqual(["checking", undefined]);
  });

  it("a shown result clears when another account signs in", async () => {
    const h = harness(["entitled"]);
    h.flow.observe({ userId: "user-a", signInOpen: false });
    h.flow.request();
    await settle();
    h.flow.observe({ userId: "user-b", signInOpen: false });
    expect(h.last()).toBeUndefined();
  });

  it("after stop a late answer publishes nothing", async () => {
    const pending = deferred<BrowserRestoreAnswer>();
    const h = harness([pending.promise]);
    h.flow.observe({ userId: "user-a", signInOpen: false });
    h.flow.request();
    h.flow.stop();
    pending.resolve("entitled");
    await settle();
    expect(h.states()).toEqual(["checking"]);
    h.flow.request();
    expect(h.check).toHaveBeenCalledTimes(1);
  });
});
