import { describe, expect, it, vi } from "vitest";
import type { UiController } from "@still/core/ui";
import { DATA_PERMISSION_COPY, type DataPermission, type DataPermissionKind } from "@still/core/ui/data-permission";
import { createExtensionPurchaseDeps, restoreHandler, withDataPermission, type SessionSender } from "../purchase-wiring.js";
import type { SessionRequest } from "../session-messages.js";

vi.mock("@still/core/ui", () => ({
  STRINGS: { account: { deleteError: "delete failed" } },
}));

// Firefox: the page's closures re-check the grant right before each send and send nothing without
// it; Restore purchase asks inside its tap first. Chrome's wiring (no DataPermission) is unchanged.

function permission(grants: Partial<Record<DataPermissionKind, boolean>>) {
  const log: string[] = [];
  const value: DataPermission = {
    ask: vi.fn((kind: DataPermissionKind) => (log.push(`ask:${kind}`), Promise.resolve(grants[kind] === true))),
    granted: vi.fn((kind: DataPermissionKind) => (log.push(`granted:${kind}`), Promise.resolve(grants[kind] === true))),
  };
  return { value, log, grants };
}

function recordingSender(log: string[] = []) {
  const send = vi.fn(async (request: SessionRequest) => {
    log.push(request.action);
    switch (request.action) {
      case "requestCode":
        return { kind: "sent" };
      case "verifyCode":
        return { kind: "verified", userId: "u1" };
      case "createCheckout":
        return { kind: "checkout-url", url: "https://checkout.invalid" };
      case "reconcile":
      case "restore":
        return "not-entitled";
      default:
        return "ok";
    }
  });
  return send as unknown as SessionSender & typeof send;
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("Firefox: no send without the grant", () => {
  it("the code send and the code check re-read the email grant first", async () => {
    const p = permission({ email: true });
    const send = recordingSender(p.log);
    const deps = withDataPermission(createExtensionPurchaseDeps(send), p.value);
    expect(deps.dataPermission).toBe(p.value);
    await deps.auth.requestCode!("me@example.com");
    await deps.auth.verifyCode!("me@example.com", "123456");
    expect(p.log).toEqual(["granted:email", "requestCode", "granted:email", "verifyCode"]);
  });

  it("withdrawn: neither the email nor the code is sent", async () => {
    const p = permission({ email: false });
    const send = recordingSender();
    const deps = withDataPermission(createExtensionPurchaseDeps(send), p.value);
    expect(await deps.auth.requestCode!("me@example.com")).toEqual({ kind: "send-failed" });
    expect(await deps.auth.verifyCode!("me@example.com", "123456")).toEqual({ kind: "verify-failed" });
    expect(send).not.toHaveBeenCalled();
  });

  it("without the purchase grant, no checkout and no reconcile (including the page-open re-check)", async () => {
    const p = permission({ purchase: false });
    const send = recordingSender();
    const deps = withDataPermission(createExtensionPurchaseDeps(send), p.value);
    expect(await deps.checkout.createCheckout()).toEqual({ kind: "unavailable" });
    expect(await deps.checkout.reconcile()).toBe("unknown");
    expect(send).not.toHaveBeenCalled();
    expect(p.value.ask).not.toHaveBeenCalled(); // no click here: these only check
  });

  it("with the purchase grant, both go to the background as before", async () => {
    const p = permission({ purchase: true });
    const send = recordingSender();
    const deps = withDataPermission(createExtensionPurchaseDeps(send), p.value);
    await deps.checkout.createCheckout();
    await deps.checkout.reconcile();
    expect(send.mock.calls.map(([request]) => request.action)).toEqual(["createCheckout", "reconcile"]);
  });
});

describe("Restore purchase (the paywall's) on Firefox", () => {
  function controllerStub() {
    return {
      setRestoreOutcome: vi.fn(),
      reSignInFromCheckout: vi.fn(),
      setPurchaseOutcome: vi.fn(),
    } as unknown as UiController & { setRestoreOutcome: ReturnType<typeof vi.fn>; setPurchaseOutcome: ReturnType<typeof vi.fn> };
  }

  it("asks inside the tap before anything else", async () => {
    const p = permission({ purchase: true });
    const send = recordingSender(p.log);
    const controller = controllerStub();
    restoreHandler(controller, send, p.value)();
    expect(p.log).toEqual(["ask:purchase"]);
    await settle();
    expect(p.log).toEqual(["ask:purchase", "restore"]);
    expect(controller.setRestoreOutcome).toHaveBeenCalledWith(false);
  });

  it("declined: nothing is sent and the line says why", async () => {
    const p = permission({ purchase: false });
    const send = recordingSender();
    const controller = controllerStub();
    restoreHandler(controller, send, p.value)();
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(controller.setPurchaseOutcome).toHaveBeenCalledWith({
      outcome: "failed",
      entitled: false,
      error: DATA_PERMISSION_COPY.purchase,
    });
  });
});

describe("Chrome (no DataPermission)", () => {
  it("sends straight away, exactly as before", async () => {
    const send = recordingSender();
    const deps = createExtensionPurchaseDeps(send);
    expect(deps.dataPermission).toBeUndefined();
    await deps.auth.requestCode!("me@example.com");
    await deps.checkout.reconcile();
    expect(send.mock.calls.map(([request]) => request.action)).toEqual(["requestCode", "reconcile"]);
    const controller = { setRestoreOutcome: vi.fn(), reSignInFromCheckout: vi.fn(), setPurchaseOutcome: vi.fn() };
    restoreHandler(controller as unknown as UiController, send, undefined)();
    await settle();
    expect(send).toHaveBeenLastCalledWith({ kind: "still:session", action: "restore" });
  });
});
