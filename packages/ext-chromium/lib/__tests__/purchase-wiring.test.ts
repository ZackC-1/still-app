import { describe, expect, it, vi } from "vitest";
import type { UiController } from "@still/core/ui";
import {
  createExtensionPurchaseDeps,
  createSessionSender,
  restoreHandler,
  type SessionSender,
} from "../purchase-wiring.js";
import type { SessionRequest } from "../session-messages.js";

vi.mock("@still/core/ui", () => ({
  STRINGS: { account: { deleteError: "delete failed" } },
}));

function senderFor(response: unknown): SessionSender {
  return (async (_request: SessionRequest) => response) as SessionSender;
}

function controllerStub() {
  return {
    setRestoreOutcome: vi.fn(),
    reSignInFromCheckout: vi.fn(),
    setPurchaseOutcome: vi.fn(),
  } as unknown as UiController & {
    setRestoreOutcome: ReturnType<typeof vi.fn>;
    reSignInFromCheckout: ReturnType<typeof vi.fn>;
    setPurchaseOutcome: ReturnType<typeof vi.fn>;
  };
}

describe("purchase wiring protocol translations", () => {
  it("distinguishes signed-out status from transport failure and retries through the background", async () => {
    const unavailable = createExtensionPurchaseDeps(createSessionSender({ sendMessage: async () => undefined }));
    const signedOut = createExtensionPurchaseDeps(createSessionSender({ sendMessage: async () => null }));
    await expect(unavailable.readAccountStatus!()).rejects.toThrow();
    await expect(signedOut.readAccountStatus!()).resolves.toBeNull();

    const status = {
      accountId: "11111111-1111-4111-8111-111111111111", email: "verified@example.test",
      lastSyncedAt: 100, pendingUpload: true, cloudReachable: false, updatedAt: 200,
    };
    const sendMessage = vi.fn(async (request: SessionRequest) => request.action === "getSyncStatus" ? status : "ok");
    const deps = createExtensionPurchaseDeps(createSessionSender({ sendMessage }));
    await expect(deps.readAccountStatus!()).resolves.toEqual(status);
    await deps.retrySync!();
    expect(sendMessage.mock.calls.map(([request]) => request)).toEqual([
      { kind: "still:session", action: "getSyncStatus" },
      { kind: "still:session", action: "retrySync" },
    ]);
    await expect(unavailable.retrySync!()).rejects.toThrow();
  });

  it("maps missing or rejected runtime responses to the action fail-safe", async () => {
    const missing = createSessionSender({ sendMessage: async () => undefined });
    const rejected = createSessionSender({ sendMessage: async () => Promise.reject(new Error("worker asleep")) });

    await expect(missing({ kind: "still:session", action: "reconcile" })).resolves.toBe("unknown");
    await expect(rejected({ kind: "still:session", action: "requestCode", email: "a@example.com" }))
      .resolves.toEqual({ kind: "send-failed" });
  });

  it("maps a signed-out reconcile to the controller's auth-required vocabulary", async () => {
    const deps = createExtensionPurchaseDeps(senderFor("signed-out"));

    await expect(deps.checkout.reconcile()).resolves.toBe("auth-required");
  });

  it("turns a failed account deletion into the shared calm error", async () => {
    const deps = createExtensionPurchaseDeps(senderFor("delete-failed"));

    await expect(deps.auth!.deleteAccount!()).rejects.toThrow("delete failed");
  });

  it("maps restore outcomes to their controller actions", async () => {
    const notEntitled = controllerStub();
    restoreHandler(notEntitled, senderFor("not-entitled"))();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notEntitled.setRestoreOutcome).toHaveBeenCalledWith(false);

    const signedOut = controllerStub();
    restoreHandler(signedOut, senderFor("signed-out"))();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signedOut.reSignInFromCheckout).toHaveBeenCalledOnce();

    const unavailable = controllerStub();
    restoreHandler(unavailable, senderFor("unknown"))();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unavailable.setPurchaseOutcome).toHaveBeenCalledWith({ outcome: "unavailable", entitled: false });
  });
});
