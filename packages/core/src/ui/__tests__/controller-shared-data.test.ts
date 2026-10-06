// The controller's account-wide "Delete shared data on all devices" flow (U5-W3 packet B; owner
// decisions 60, 61 and 74): load, confirm, progress, failure and retry, the other-device line, and
// that it reports no new analytics event.
import { describe, it, expect, vi } from "vitest";
import type { UiAccountErasure, UiAccountErasureView, UiAnalytics } from "../controller.svelte.js";
import { makeController, recordingAnalytics } from "./support/controller-fixtures.js";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const view = (withdrawal: UiAccountErasureView["withdrawal"], stoppedElsewhere = false): UiAccountErasureView => ({
  withdrawal,
  stoppedElsewhere,
});

function setup(service: Partial<UiAccountErasure> = {}, sharing = true) {
  const recording = recordingAnalytics();
  const accountErasure: UiAccountErasure = {
    state: vi.fn(async () => view("none")),
    start: vi.fn(async () => view("requested")),
    retry: vi.fn(async () => view("requested")),
    acknowledge: vi.fn(),
    ...service,
  };
  let enabled = sharing;
  const analytics: UiAnalytics = {
    ...recording.analytics,
    sharing: vi.fn(async () => ({ enabled, noticeNeeded: false })),
    accountErasure,
  };
  const { c } = makeController({ analytics });
  return { c, accountErasure, analytics, calls: recording.calls, stopSharing: () => (enabled = false) };
}

describe("Delete shared data on all devices (controller)", () => {
  it("is hidden while signed out, and when the host does not offer it", async () => {
    const t = setup();
    await t.c.loadSharedData();
    expect(t.c.sharedData).toBeNull();
    expect(t.accountErasure.state).not.toHaveBeenCalled();
    const dormant = setup({ state: vi.fn(async () => null) });
    dormant.c.userId = ACCOUNT;
    await dormant.c.loadSharedData();
    expect(dormant.c.sharedData).toBeNull();
    const none = makeController({ analytics: recordingAnalytics().analytics }).c;
    none.userId = ACCOUNT;
    await none.loadSharedData();
    expect(none.sharedData).toBeNull();
  });

  it("idle → confirm: the local stop and request go through the host, synchronously from the tap", async () => {
    const t = setup();
    t.c.userId = ACCOUNT;
    await t.c.loadSharedData();
    expect(t.c.sharedData).toEqual({ account: ACCOUNT, ...view("none") });
    let resolve!: (v: UiAccountErasureView) => void;
    vi.mocked(t.accountErasure.start).mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const done = t.c.confirmDeleteSharedData();
    expect(t.accountErasure.start).toHaveBeenCalledWith(ACCOUNT); // no await before it (Firefox's gesture)
    expect(t.c.sharedDataSending).toBe(true);
    void t.c.confirmDeleteSharedData(); // a double tap sends nothing more
    expect(t.accountErasure.start).toHaveBeenCalledTimes(1);
    t.stopSharing();
    resolve(view("requested"));
    await done;
    expect(t.c.sharedDataSending).toBe(false);
    expect(t.c.sharedData).toEqual({ account: ACCOUNT, ...view("requested") });
    await vi.waitFor(() => expect(t.c.usageSharing).toBe(false)); // the switch shows it off here
    // No new analytics event (the closed schema is unchanged).
    expect(t.calls).toEqual([]);
  });

  it("progress and done: the host's lines; done and the other-device line are acknowledged once shown", async () => {
    const t = setup({ state: vi.fn(async () => view("verifying")) });
    t.c.userId = ACCOUNT;
    await t.c.loadSharedData();
    expect(t.c.sharedData?.withdrawal).toBe("verifying");
    expect(t.accountErasure.acknowledge).not.toHaveBeenCalled();
    vi.mocked(t.accountErasure.state).mockResolvedValueOnce(view("deleted"));
    await t.c.loadSharedData();
    expect(t.c.sharedData?.withdrawal).toBe("deleted");
    expect(t.accountErasure.acknowledge).toHaveBeenCalledWith(ACCOUNT);
    vi.mocked(t.accountErasure.state).mockResolvedValueOnce(view("none", true));
    await t.c.loadSharedData();
    expect(t.c.sharedData).toEqual({ account: ACCOUNT, ...view("none", true) });
    expect(t.accountErasure.acknowledge).toHaveBeenCalledTimes(2);
  });

  it("failure and retry: the failed line, then Try again through the host's retry", async () => {
    const t = setup({ start: vi.fn(async () => view("failed")) });
    t.c.userId = ACCOUNT;
    await t.c.loadSharedData();
    await t.c.confirmDeleteSharedData();
    expect(t.c.sharedData?.withdrawal).toBe("failed");
    await t.c.retryDeleteSharedData();
    expect(t.accountErasure.retry).toHaveBeenCalledWith(ACCOUNT);
    expect(t.c.sharedData?.withdrawal).toBe("requested");
    expect(t.accountErasure.start).toHaveBeenCalledTimes(1);
  });

  it("nothing sent (null): shows what the host holds, never a failure line it did not report", async () => {
    const t = setup({ start: vi.fn(async () => null) });
    t.c.userId = ACCOUNT;
    await t.c.loadSharedData();
    await t.c.confirmDeleteSharedData();
    expect(t.c.sharedData).toEqual({ account: ACCOUNT, ...view("none") });
    const thrown = setup({ start: vi.fn(async () => Promise.reject(new Error("port closed"))) });
    thrown.c.userId = ACCOUNT;
    await thrown.c.loadSharedData();
    await thrown.c.confirmDeleteSharedData();
    expect(thrown.c.sharedData?.withdrawal).toBe("none");
    expect(thrown.c.sharedDataSending).toBe(false);
  });

  it("another account or a sign-out meanwhile: the outcome is not shown for the wrong account", async () => {
    const t = setup();
    t.c.userId = ACCOUNT;
    await t.c.loadSharedData();
    let resolve!: (v: UiAccountErasureView) => void;
    vi.mocked(t.accountErasure.start).mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const done = t.c.confirmDeleteSharedData();
    t.c.userId = OTHER;
    resolve(view("failed"));
    await done;
    expect(t.c.sharedData?.withdrawal).not.toBe("failed");
    expect(t.c.sharedDataSending).toBe(false);
    // Sign-out clears it.
    t.c.userId = ACCOUNT;
    await t.c.loadSharedData();
    await t.c.signOut();
    expect(t.c.sharedData).toBeNull();
  });

  it("NEGATIVE CONTROL: confirming before the state was read (or for another account) sends nothing", async () => {
    const t = setup();
    t.c.userId = ACCOUNT;
    await t.c.confirmDeleteSharedData();
    expect(t.accountErasure.start).not.toHaveBeenCalled();
    await t.c.loadSharedData();
    t.c.userId = OTHER;
    await t.c.confirmDeleteSharedData();
    expect(t.accountErasure.start).not.toHaveBeenCalled();
  });
});
