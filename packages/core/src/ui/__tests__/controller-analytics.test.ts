import { describe, it, expect, vi } from "vitest";
import { NEW_ACCOUNT_WINDOW_MS } from "../controller.svelte.js";
import type { VerifyCodeOutcome } from "../../sync/ports.js";
import { codeAuth, makeController, recordingAnalytics } from "./support/controller-fixtures.js";

// The controller reports the sign-in funnel and settings changes through the host's analytics
// seam. These tests pin what is reported and in which order, because the dashboard's funnels are
// built from exactly these names.

const NOW = Date.UTC(2026, 8, 23, 18, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

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
      ["service_toggled", { service: "instagram", enabled: false }],
      ["global_toggled", { enabled: false }],
    ]);
  });

  it("reports a new account through the whole funnel", async () => {
    const { analytics, calls } = recordingAnalytics();
    const auth = verifying({ kind: "verified", userId: "u1", email: "a@b.co", accountCreatedAt: iso(NOW - 60_000) });
    const { c } = makeController({ auth, analytics, clock: () => NOW, host: { emailConsent: "none" } });
    c.openSignIn();
    c.openSignIn(); // already open: not a second funnel entry
    await c.signIn("a@b.co");
    await c.verifyCode("123456");
    expect(calls).toEqual([
      ["sign_in_opened", {}],
      ["code_requested", {}],
      ["$identify", "u1"],
      ["account_created", {}],
    ]);
  });

  it("an older account is a sign-in, and a missing creation time is never counted as new", async () => {
    for (const accountCreatedAt of [iso(NOW - NEW_ACCOUNT_WINDOW_MS - 1), null, "not a date"]) {
      const { analytics, calls } = recordingAnalytics();
      const auth = verifying({ kind: "verified", userId: "u1", accountCreatedAt });
      const { c } = makeController({ auth, analytics, clock: () => NOW });
      await c.signIn("a@b.co");
      await c.verifyCode("123456");
      expect(calls.at(-1)).toEqual(["signed_in", {}]);
    }
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

  it("reports sign-out and deletion before it stops attributing to the account", async () => {
    const out = recordingAnalytics();
    const a = makeController({ auth: codeAuth(), analytics: out.analytics });
    a.c.userId = "u1";
    await a.c.signOut();
    expect(out.calls).toEqual([["signed_out", {}], ["$reset"]]);

    const del = recordingAnalytics();
    const b = makeController({ auth: codeAuth({ deleteAccount: vi.fn(() => Promise.resolve()) }), analytics: del.analytics });
    b.c.userId = "u1";
    await b.c.confirmDeleteAccount();
    expect(del.calls).toEqual([["account_deleted", {}], ["$reset"]]);
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
