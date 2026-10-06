import { describe, expect, it, vi } from "vitest";
import type { ExtensionSession } from "@still/core/sync";
import { RESTORE_SESSION_KIND, settingsRestoreHost } from "../settings-restore.js";
import {
  SESSION_MESSAGE_KIND,
  SESSION_PROTOCOL,
  createSessionMessageRouter,
  isSessionRequest,
} from "../session-messages.js";

// The browser settings page's free-period Restore check (owner decisions 62 and 73). It sends one
// message, the existing reconcile-only `restore` action, and nothing that could buy anything.

const controller = { userId: "user-a", signInOpen: false, canSignIn: true, openSignIn: vi.fn() };

describe("settings Restore check message", () => {
  it("uses the session protocol's own message kind", () => {
    expect(RESTORE_SESSION_KIND).toBe(SESSION_MESSAGE_KIND);
  });

  it("sends exactly one valid restore request and returns the session's answer", async () => {
    for (const answer of ["entitled", "not-entitled", "unknown", "auth-required", "signed-out"]) {
      const sendMessage = vi.fn(async (_message: unknown) => answer);
      const host = settingsRestoreHost(controller, { sendMessage });
      await expect(host.check()).resolves.toBe(answer);
      expect(sendMessage.mock.calls).toEqual([[{ kind: SESSION_MESSAGE_KIND, action: "restore" }]]);
      expect(isSessionRequest(sendMessage.mock.calls[0]![0])).toBe(true);
    }
  });

  it.each([
    ["a rejected transport", () => Promise.reject(new Error("no receiver"))],
    ["no reply", () => Promise.resolve(undefined)],
    ["a reply outside the vocabulary", () => Promise.resolve({ kind: "checkout-url", url: "https://x.invalid" })],
  ])("settles %s to unknown", async (_name, reply) => {
    const host = settingsRestoreHost(controller, { sendMessage: vi.fn(reply) });
    await expect(host.check()).resolves.toBe("unknown");
  });

  it("uses Firefox's browser.runtime when present, else chrome.runtime", async () => {
    const chromeSend = vi.fn(async () => "entitled");
    const browserSend = vi.fn(async () => "not-entitled");
    vi.stubGlobal("chrome", { runtime: { sendMessage: chromeSend } });
    try {
      await expect(settingsRestoreHost(controller).check()).resolves.toBe("entitled");
      vi.stubGlobal("browser", { runtime: { id: "firefox-id", sendMessage: browserSend } });
      await expect(settingsRestoreHost(controller).check()).resolves.toBe("not-entitled");
      expect(chromeSend).toHaveBeenCalledTimes(1);
      expect(browserSend).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the background answers the check with a reconcile and nothing else", () => {
  it("routes the restore message to session.restore only: no checkout, purchase intent or pending checkout", async () => {
    const calls: string[] = [];
    const session = new Proxy({} as ExtensionSession, {
      get: (_target, name: string) => async () => {
        calls.push(name);
        return name === "restore" ? "entitled" : undefined;
      },
    });
    const origin = "chrome-extension://synthetic/";
    const router = createSessionMessageRouter(session, "synthetic", origin);
    const sendMessage = (message: unknown) =>
      new Promise<unknown>((resolve) => {
        const handled = router(message, { id: "synthetic", url: `${origin}options.html` }, resolve);
        if (!handled) resolve(undefined);
      });
    const host = settingsRestoreHost(controller, { sendMessage });
    await expect(host.check()).resolves.toBe("entitled");
    expect(calls).toEqual(["restore"]);
    // Negative control on the claim: the protocol does have purchase capabilities this never uses.
    expect(Object.keys(SESSION_PROTOCOL)).toEqual(
      expect.arrayContaining(["createCheckout", "setPurchaseIntent", "setCheckoutPending"]),
    );
  });
});
