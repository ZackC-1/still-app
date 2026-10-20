// ISS-0111: the controller's "Share usage data" state is not decided by one read at construction.
// Hosts build the controller before their analytics has started, so the controller reads the
// state again when the host says it has settled (refreshUsageSharing), and after a sign-out. The
// Apple composition is covered end to end in analytics/__tests__/apple-default-on.test.ts.
import { describe, expect, it, vi } from "vitest";
import type { UiAnalytics, UsageSharingState } from "../controller.svelte.js";
import { codeAuth, makeController, recordingAnalytics } from "./support/controller-fixtures.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function host(first: UsageSharingState | null) {
  let answer: UsageSharingState | null = first;
  const analytics: UiAnalytics = {
    ...recordingAnalytics().analytics,
    sharing: vi.fn(async () => answer),
    setSharing: vi.fn(async (enabled: boolean) => enabled),
  };
  return { analytics, answer: (next: UsageSharingState | null) => (answer = next) };
}

describe("UiController: the usage-sharing switch follows the host once it knows", () => {
  it("an unknown first answer shows the switch once a later read knows it", async () => {
    const h = host(null);
    const { c } = makeController({ analytics: h.analytics });
    await settle();
    expect(c.usageSharing).toBeNull();
    h.answer({ enabled: false, noticeNeeded: false });
    await c.refreshUsageSharing();
    expect(c.usageSharing).toBe(false);
  });

  it("an unknown later answer never hides a switch already shown", async () => {
    const h = host({ enabled: false, noticeNeeded: false });
    const { c } = makeController({ analytics: h.analytics });
    await settle();
    h.answer(null);
    await c.refreshUsageSharing();
    expect(c.usageSharing).toBe(false);
  });

  it("reads the state again after a sign-out", async () => {
    const h = host(null);
    const { c } = makeController({ analytics: h.analytics, auth: codeAuth() });
    await settle();
    c.userId = "user-1";
    h.answer({ enabled: false, noticeNeeded: false });
    await c.signOut();
    await settle();
    expect(c.usageSharing).toBe(false);
  });

  it("a read that straddles a switch change does not undo it", async () => {
    const h = host({ enabled: true, noticeNeeded: false });
    const { c } = makeController({ analytics: h.analytics });
    await settle();
    let answerStale!: (state: UsageSharingState) => void;
    vi.mocked(h.analytics.sharing!).mockImplementationOnce(() => new Promise((resolve) => (answerStale = resolve)));
    const refresh = c.refreshUsageSharing();
    c.toggleUsageSharing(); // off
    await settle();
    expect(c.usageSharing).toBe(false);
    answerStale({ enabled: true, noticeNeeded: false }); // read before the change landed
    await refresh;
    expect(c.usageSharing).toBe(false);
  });
});
