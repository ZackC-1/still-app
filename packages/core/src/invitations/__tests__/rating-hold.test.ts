import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RATING_HOLD_FLOWS, appleRatingHold, reportRatingHold, type AppleRatingHoldInputs } from "../rating-hold.js";

const calm: AppleRatingHoldInputs = {
  authFlow: "idle", signInOpen: false, usageNoticeVisible: false, deleteFlow: "idle", purchaseFlow: "idle",
  checkoutFlow: "none", paywallOpen: false, successScreen: "none", signedIn: false, cloudReachable: true,
  restoreShown: false, settingsHeld: false,
};

describe("the Apple rating hold the web UI reports", () => {
  it("is none only on a calm settings screen", () => {
    expect(appleRatingHold(calm)).toBe("none");
    expect(appleRatingHold({ ...calm, signedIn: true })).toBe("none");
  });

  it.each([
    [{ signInOpen: true }, "signIn"],
    // Returning from Mail with a code: the code entry comes back with the sheet.
    [{ authFlow: "code-entry" }, "signIn"],
    [{ authFlow: "verifying" }, "signIn"],
    [{ authFlow: "sent" }, "signIn"],
    [{ usageNoticeVisible: true }, "consent"],
    [{ restoreShown: true }, "restore"],
    [{ purchaseFlow: "purchasing" }, "purchase"],
    [{ paywallOpen: true }, "purchase"],
    [{ checkoutFlow: "checking" }, "purchase"],
    [{ successScreen: "account-pitch" }, "purchase"],
    [{ deleteFlow: "confirming" }, "delete"],
    [{ deleteFlow: "deleting" }, "delete"],
    [{ deleteFlow: "error" }, "delete"],
    [{ settingsHeld: true }, "error"],
    [{ signedIn: true, cloudReachable: false }, "error"],
  ] as [Partial<AppleRatingHoldInputs>, string][])("%j holds as %s", (change, flow) => {
    expect(appleRatingHold({ ...calm, ...change })).toBe(flow);
    expect(RATING_HOLD_FLOWS).toContain(flow);
  });

  it("a deletion or Restore outranks everything else on screen", () => {
    const busy = { ...calm, signInOpen: true, usageNoticeVisible: true, settingsHeld: true, paywallOpen: true };
    expect(appleRatingHold({ ...busy, deleteFlow: "deleting", restoreShown: true })).toBe("delete");
    expect(appleRatingHold({ ...busy, restoreShown: true })).toBe("restore");
  });

  it("posts one closed word over the still bridge, and nothing outside the Apple app", async () => {
    const postMessage = vi.fn(async () => ({ ok: true }));
    reportRatingHold("signIn", { webkit: { messageHandlers: { still: { postMessage } } } });
    expect(postMessage).toHaveBeenCalledWith({ kind: "ratingHold", flow: "signIn" });
    expect(() => reportRatingHold("none", {})).not.toThrow();
    const failing = vi.fn(async () => { throw new Error("gone"); });
    expect(() => reportRatingHold("none", { webkit: { messageHandlers: { still: { postMessage: failing } } } })).not.toThrow();
    const throwing = vi.fn(() => { throw new Error("gone"); });
    expect(() => reportRatingHold("none", { webkit: { messageHandlers: { still: { postMessage: throwing } } } })).not.toThrow();
  });

  it("the Apple settings host reports it on every change", () => {
    const host = readFileSync(resolve(import.meta.dirname, "../../../../app-webview/src/AppleSettingsHost.svelte"), "utf8");
    expect(host).toContain("$effect(() => reportRatingHold(ratingHold));");
    for (const field of ["authFlow", "signInOpen", "usageNoticeVisible", "deleteFlow", "purchaseFlow", "checkoutFlow",
      "paywallOpen", "successScreen", "cloudReachable", "restoreShown", "settingsHeld"]) {
      expect(host).toContain(`${field}:`);
    }
  });
});
