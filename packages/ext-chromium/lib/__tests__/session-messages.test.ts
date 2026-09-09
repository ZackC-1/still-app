import { describe, expect, it, vi } from "vitest";
import type { ExtensionSession } from "@still/core/sync";
import {
  SESSION_MESSAGE_KIND,
  createSessionMessageRouter,
  isExtensionPageSender,
  isSessionRequest,
  unavailableResponse,
  type SessionRequest,
  type SessionResponses,
} from "../session-messages.js";

const responseTypePins: [SessionResponses["reconcile"], SessionResponses["requestCode"]] = [
  "entitled",
  { kind: "sent" },
];

function sessionStub(): ExtensionSession {
  return {
    getState: vi.fn(async () => ({ userId: "user", entitled: true, checkoutPending: null, pendingOtp: null })),
    getSyncStatus: vi.fn(async () => ({
      accountId: "11111111-1111-4111-8111-111111111111", email: "verified@example.test",
      lastSyncedAt: 100, pendingUpload: true, cloudReachable: false, updatedAt: 200,
    })),
    retrySync: vi.fn(async () => {}),
    requestCode: vi.fn(async () => ({ kind: "sent" as const })),
    verifyCode: vi.fn(async () => ({ kind: "verified" as const, userId: "user" })),
    signOut: vi.fn(async () => "signed-out" as const),
    deleteAccount: vi.fn(async () => "deleted" as const),
    reconcile: vi.fn(async () => "entitled" as const),
    restore: vi.fn(async () => "not-entitled" as const),
    createCheckout: vi.fn(async () => ({ kind: "checkout-url" as const, url: "https://checkout" })),
    setPendingOtp: vi.fn(async () => {}),
    setPurchaseIntent: vi.fn(async () => {}),
    setCheckoutPending: vi.fn(async () => {}),
    onNudge: vi.fn(async () => "no-op" as const),
    resume: vi.fn(async () => "signed-out" as const),
  };
}

const requests: SessionRequest[] = [
  { kind: SESSION_MESSAGE_KIND, action: "getState" },
  { kind: SESSION_MESSAGE_KIND, action: "getSyncStatus" },
  { kind: SESSION_MESSAGE_KIND, action: "retrySync" },
  { kind: SESSION_MESSAGE_KIND, action: "requestCode", email: "a@example.com" },
  { kind: SESSION_MESSAGE_KIND, action: "verifyCode", email: "a@example.com", token: "123456" },
  { kind: SESSION_MESSAGE_KIND, action: "signOut" },
  { kind: SESSION_MESSAGE_KIND, action: "deleteAccount" },
  { kind: SESSION_MESSAGE_KIND, action: "reconcile" },
  { kind: SESSION_MESSAGE_KIND, action: "restore" },
  { kind: SESSION_MESSAGE_KIND, action: "createCheckout" },
  { kind: SESSION_MESSAGE_KIND, action: "setPendingOtp", pending: { email: "a@example.com", requestedAt: 1 } },
  { kind: SESSION_MESSAGE_KIND, action: "setPurchaseIntent", active: true },
  { kind: SESSION_MESSAGE_KIND, action: "setCheckoutPending", pending: { startedAt: 1, tabId: 2 } },
];

describe("session protocol registry", () => {
  it("keeps action responses coupled to the registry", () => {
    expect(responseTypePins).toEqual(["entitled", { kind: "sent" }]);
  });

  it("round-trips every declared action through the privileged message listener", async () => {
    const session = sessionStub();
    const router = createSessionMessageRouter(session, "still", "chrome-extension://still/");

    const responses = await Promise.all(requests.map((request) => sendThrough(router, request)));

    expect(responses).toEqual([
      { userId: "user", entitled: true, checkoutPending: null, pendingOtp: null },
      {
        accountId: "11111111-1111-4111-8111-111111111111", email: "verified@example.test",
        lastSyncedAt: 100, pendingUpload: true, cloudReachable: false, updatedAt: 200,
      },
      "ok",
      { kind: "sent" },
      { kind: "verified", userId: "user" },
      "signed-out",
      "deleted",
      "entitled",
      "not-entitled",
      { kind: "checkout-url", url: "https://checkout" },
      "ok",
      "ok",
      "ok",
    ]);
    expect(session.getState).toHaveBeenCalledOnce();
    expect(session.getSyncStatus).toHaveBeenCalledOnce();
    expect(session.retrySync).toHaveBeenCalledOnce();
    expect(session.requestCode).toHaveBeenCalledWith("a@example.com");
    expect(session.verifyCode).toHaveBeenCalledWith("a@example.com", "123456");
    expect(session.signOut).toHaveBeenCalledOnce();
    expect(session.deleteAccount).toHaveBeenCalledOnce();
    expect(session.reconcile).toHaveBeenCalledOnce();
    expect(session.restore).toHaveBeenCalledOnce();
    expect(session.createCheckout).toHaveBeenCalledOnce();
    expect(session.setPendingOtp).toHaveBeenCalledWith({ email: "a@example.com", requestedAt: 1 });
    expect(session.setPurchaseIntent).toHaveBeenCalledWith(true);
    expect(session.setCheckoutPending).toHaveBeenCalledWith({ startedAt: 1, tabId: 2 });
  });

  it("returns each action's registry-owned unavailable answer without a session", async () => {
    const router = createSessionMessageRouter(null, "still", "chrome-extension://still/");
    for (const request of requests) {
      await expect(sendThrough(router, request)).resolves.toEqual(unavailableResponse(request.action));
    }
  });

  it("rejects unknown and malformed actions before privileged dispatch", () => {
    expect(isSessionRequest({ kind: SESSION_MESSAGE_KIND, action: "futureAction" })).toBe(false);
    expect(isSessionRequest({ kind: SESSION_MESSAGE_KIND, action: "requestCode" })).toBe(false);
    expect(isSessionRequest({ kind: SESSION_MESSAGE_KIND, action: "setPendingOtp", pending: { email: 1 } })).toBe(false);
    expect(isSessionRequest(requests[0])).toBe(true);
  });

  it("accepts extension pages, including embedded options, and rejects page senders", async () => {
    const origin = "chrome-extension://still/";
    expect(isExtensionPageSender({ id: "still", url: `${origin}popup.html` }, "still", origin)).toBe(true);
    expect(isExtensionPageSender({ id: "still", url: `${origin}options.html`, tab: {} }, "still", origin)).toBe(true);
    expect(isExtensionPageSender({ id: "still", url: "https://www.youtube.com/", tab: {} }, "still", origin)).toBe(false);
    expect(isExtensionPageSender({ id: "other", url: `${origin}popup.html` }, "still", origin)).toBe(false);
    const router = createSessionMessageRouter(sessionStub(), "still", origin);
    await expect(sendThrough(router, requests[0]!, { id: "still", url: "https://www.youtube.com/", tab: {} })).resolves.toBeUndefined();
  });

  it("never reveals account email or starts a sync retry for content-script senders", async () => {
    const session = sessionStub();
    const router = createSessionMessageRouter(session, "still", "chrome-extension://still/");
    for (const action of ["getSyncStatus", "retrySync"] as const) {
      for (const url of ["https://www.youtube.com/", "https://www.instagram.com/", "https://www.tiktok.com/", "https://www.facebook.com/"]) {
        await expect(sendThrough(router, { kind: SESSION_MESSAGE_KIND, action }, { id: "still", url, tab: {} }))
          .resolves.toBeUndefined();
      }
    }
    expect(session.getSyncStatus).not.toHaveBeenCalled();
    expect(session.retrySync).not.toHaveBeenCalled();
  });

  it("keeps unavailable account status distinct from an explicit signed-out reply", async () => {
    const session = sessionStub();
    const router = createSessionMessageRouter(session, "still", "chrome-extension://still/");
    vi.mocked(session.getSyncStatus).mockRejectedValueOnce(new Error("auth unavailable"));
    await expect(sendThrough(router, { kind: SESSION_MESSAGE_KIND, action: "getSyncStatus" }))
      .resolves.toBe("unavailable");
    vi.mocked(session.getSyncStatus).mockResolvedValueOnce(null);
    await expect(sendThrough(router, { kind: SESSION_MESSAGE_KIND, action: "getSyncStatus" }))
      .resolves.toBeNull();
  });
});

function sendThrough(
  listener: ReturnType<typeof createSessionMessageRouter>,
  request: SessionRequest,
  sender: { id: string; url: string; tab?: unknown } = { id: "still", url: "chrome-extension://still/popup.html" },
): Promise<unknown> {
  return new Promise((resolve) => {
    if (!listener(request, sender, resolve)) resolve(undefined);
  });
}
