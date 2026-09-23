import { describe, it, expect, vi } from "vitest";
import type { VerifyCodeOutcome } from "../../sync/ports.js";
import { codeAuth, makeController, recordingAnalytics } from "./support/controller-fixtures.js";

// The controller reports the sign-in funnel and settings changes through the host's analytics
// seam. These tests pin what is reported and in which order, because the dashboard's funnels are
// built from exactly these names.

const NOW = Date.UTC(2026, 8, 23, 18, 0, 0);

function verifying(outcome: VerifyCodeOutcome) {
  return codeAuth({ verifyCode: vi.fn(() => Promise.resolve(outcome)) });
}

describe("UiController analytics", () => {
  it("reports toggles with the new value", () => {
    const { analytics, calls } = recordingAnalytics();
    const { c } = makeController({ analytics });
    c.toggleService("instagram");
    c.toggleGlobal();
    expect(calls).toEqual([
      ["service_toggled", { service: "instagram", enabled: false, where: "app" }],
      ["global_toggled", { enabled: false, where: "app" }],
    ]);
  });

  it("reports the funnel through sign-in; a new account is counted by the server, not here", async () => {
    const { analytics, calls } = recordingAnalytics();
    const auth = verifying({ kind: "verified", userId: "u1", email: "a@b.co" });
    const { c } = makeController({ auth, analytics, clock: () => NOW, host: { emailConsent: "none" } });
    c.openSignIn();
    c.openSignIn(); // already open: not a second funnel entry
    await c.signIn("a@b.co");
    await c.verifyCode("123456");
    expect(calls).toEqual([
      ["sign_in_opened", {}],
      ["code_requested", {}],
      ["$identify", "u1"],
      ["signed_in", {}],
    ]);
  });

  it("reports why a code failed", async () => {
    const cases: [VerifyCodeOutcome, string][] = [
      [{ kind: "invalid-code" }, "wrong"],
      [{ kind: "verify-rate-limited" }, "rate_limited"],
      [{ kind: "verify-failed" }, "network"],
    ];
    for (const [outcome, reason] of cases) {
      const { analytics, calls } = recordingAnalytics();
      const { c } = makeController({ auth: verifying(outcome), analytics, clock: () => NOW });
      await c.signIn("a@b.co");
      await c.verifyCode("000000");
      expect(calls.at(-1)).toEqual(["code_failed", { reason }]);
    }
  });

  it("reports a send that could not go out", async () => {
    const { analytics, calls } = recordingAnalytics();
    const auth = codeAuth({ requestCode: vi.fn(() => Promise.resolve({ kind: "send-rate-limited" as const })) });
    const { c } = makeController({ auth, analytics });
    await c.signIn("a@b.co");
    expect(calls).toEqual([["code_failed", { reason: "rate_limited" }]]);
  });

  it("reports where someone gave up", async () => {
    const early = recordingAnalytics();
    const a = makeController({ auth: codeAuth(), analytics: early.analytics });
    a.c.openSignIn();
    a.c.dismissSignIn();
    a.c.dismissSignIn(); // already closed: nothing more
    expect(early.calls).toEqual([["sign_in_opened", {}], ["sign_in_abandoned", { stage: "email" }]]);

    const late = recordingAnalytics();
    const b = makeController({ auth: codeAuth(), analytics: late.analytics });
    b.c.openSignIn();
    await b.c.signIn("a@b.co");
    b.c.dismissSignIn();
    expect(late.calls.at(-1)).toEqual(["sign_in_abandoned", { stage: "code" }]);
  });

  it("reports sign-out under the account, and deletion only after forgetting it", async () => {
    const out = recordingAnalytics();
    const a = makeController({ auth: codeAuth(), analytics: out.analytics });
    a.c.userId = "u1";
    await a.c.signOut();
    expect(out.calls).toEqual([["signed_out", {}], ["$reset"]]);

    const del = recordingAnalytics();
    const b = makeController({ auth: codeAuth({ deleteAccount: vi.fn(() => Promise.resolve()) }), analytics: del.analytics });
    b.c.userId = "u1";
    await b.c.confirmDeleteAccount();
    expect(del.calls).toEqual([["$reset-forget"], ["account_deleted", {}]]);
  });

  it("a throwing analytics seam never breaks the UI", () => {
    const { c, cache } = makeController({
      analytics: { track: () => { throw new Error("boom"); }, identify: () => {}, reset: () => {} },
    });
    const spy = vi.spyOn(cache, "setService");
    expect(() => c.toggleService("youtube")).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});

describe("UiController usage sharing", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("shows no switch when the build has no analytics", async () => {
    const { c } = makeController();
    await flush();
    expect(c.usageSharing).toBeNull();
    expect(c.usageNoticeVisible).toBe(false);
  });

  it("loads the state, shows the notice once, and the notice's off button turns sharing off", async () => {
    const { analytics } = recordingAnalytics();
    const setSharing = vi.fn(async (enabled: boolean) => enabled);
    const acknowledgeNotice = vi.fn();
    const { c } = makeController({
      analytics: { ...analytics, sharing: async () => ({ enabled: true, noticeNeeded: true }), setSharing, acknowledgeNotice },
    });
    await flush();
    expect(c.usageSharing).toBe(true);
    expect(c.usageNoticeVisible).toBe(true);
    c.toggleUsageSharing();
    expect(setSharing).toHaveBeenCalledWith(false); // synchronously, inside the tap
    await flush();
    expect(c.usageSharing).toBe(false);
    expect(c.usageNoticeVisible).toBe(false);
    expect(acknowledgeNotice).toHaveBeenCalledTimes(1);
  });

  it("a declined prompt leaves the switch where the host says it is", async () => {
    const { analytics } = recordingAnalytics();
    const { c } = makeController({
      analytics: { ...analytics, sharing: async () => ({ enabled: false, noticeNeeded: false }), setSharing: async () => false },
    });
    await flush();
    expect(c.usageNoticeVisible).toBe(false);
    c.toggleUsageSharing();
    await flush();
    expect(c.usageSharing).toBe(false);
  });
});
