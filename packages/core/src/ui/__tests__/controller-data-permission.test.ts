// Firefox's optional data-collection permissions, as the UI controller uses them.
//
// The email address and the Still Pro purchase status are optional in Firefox's manifest, so
// Firefox asks the person the first time Still would send them. The rules pinned here:
//   * the ask is made synchronously, inside the click, before anything is awaited (Firefox only
//     prompts from a user action, and a handler that awaited has stopped being one);
//   * declined means nothing is sent, and the sheet says why in one line;
//   * the grant is re-checked before every later send (resend, verify, checkout);
//   * a host with no DataPermission (Chrome, Safari, Apple) asks nothing and behaves as before.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import App from "../App.svelte";
import { STRINGS } from "../strings.js";
import {
  DATA_PERMISSION_COPY,
  type DataPermission,
  type DataPermissionKind,
} from "../data-permission.js";
import { codeAuth, checkoutSeam, makeController } from "./support/controller-fixtures.js";

function permission(answer: Partial<Record<DataPermissionKind, boolean>> = {}) {
  const log: string[] = [];
  const value = {
    ask: vi.fn((kind: DataPermissionKind) => {
      log.push(`ask:${kind}`);
      return Promise.resolve(answer[kind] ?? true);
    }),
    granted: vi.fn((kind: DataPermissionKind) => {
      log.push(`granted:${kind}`);
      return Promise.resolve(answer[kind] ?? true);
    }),
    set(kind: DataPermissionKind, granted: boolean) {
      answer[kind] = granted;
    },
  } satisfies DataPermission & { set: unknown };
  return { permission: value, log };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("sign-in: the email address is sent only with Firefox's permission", () => {
  it("asks inside the tap, before anything is awaited, then sends the code", async () => {
    const { permission: dataPermission, log } = permission();
    const auth = codeAuth({
      requestCode: vi.fn(async () => {
        log.push("requestCode");
        return { kind: "sent" } as const;
      }),
    });
    const { c } = makeController({ auth, host: { dataPermission } });
    const pending = c.signIn("me@example.com");
    // Synchronous: already asked when signIn returns its promise, and nothing sent yet.
    expect(log).toEqual(["ask:email"]);
    await pending;
    expect(log).toEqual(["ask:email", "requestCode"]);
    expect(c.authFlow).toBe("code-entry");
    expect(c.dataPermissionNotice).toBeNull();
  });

  it("declined: no code is requested and the sheet says why", async () => {
    const { permission: dataPermission } = permission({ email: false });
    const auth = codeAuth();
    const { c } = makeController({ auth, host: { dataPermission } });
    c.openSignIn();
    await c.signIn("me@example.com");
    expect(auth.requestCode).not.toHaveBeenCalled();
    expect(c.authFlow).toBe("idle");
    expect(c.dataPermissionNotice).toBe("email");
  });

  it("does not ask for an invalid address (nothing would be sent)", async () => {
    const { permission: dataPermission } = permission();
    const { c } = makeController({ auth: codeAuth(), host: { dataPermission } });
    await c.signIn("not-an-address");
    expect(dataPermission.ask).not.toHaveBeenCalled();
  });

  it("a later yes clears the line and sends", async () => {
    const { permission: dataPermission } = permission({ email: false });
    const auth = codeAuth();
    const { c } = makeController({ auth, host: { dataPermission } });
    await c.signIn("me@example.com");
    expect(c.dataPermissionNotice).toBe("email");
    dataPermission.set("email", true);
    await c.signIn("me@example.com");
    expect(auth.requestCode).toHaveBeenCalledOnce();
    expect(c.dataPermissionNotice).toBeNull();
  });

  it("resend asks again first; withdrawn means no resend and the line, still on code entry", async () => {
    let now = 1_000_000;
    const { permission: dataPermission, log } = permission();
    const auth = codeAuth();
    const { c } = makeController({ auth, host: { dataPermission }, clock: () => now });
    await c.signIn("me@example.com");
    now += 10 * 60_000; // past the resend cooldown
    dataPermission.set("email", false);
    log.length = 0;
    const pending = c.resendCode();
    expect(log).toEqual(["ask:email"]);
    await pending;
    expect(auth.requestCode).toHaveBeenCalledOnce(); // only the first send
    expect(c.authFlow).toBe("code-entry");
    expect(c.dataPermissionNotice).toBe("email");
    c.dispose();
  });

  it("verify re-checks the grant before the email and code are sent", async () => {
    const { permission: dataPermission, log } = permission();
    const auth = codeAuth({
      verifyCode: vi.fn(async () => {
        log.push("verifyCode");
        return { kind: "verified", userId: "user-1" } as const;
      }),
    });
    const { c } = makeController({ auth, host: { dataPermission } });
    await c.signIn("me@example.com");
    log.length = 0;
    const pending = c.verifyCode("123456");
    expect(log).toEqual(["ask:email"]);
    await pending;
    expect(log).toEqual(["ask:email", "verifyCode"]);
    expect(c.userId).toBe("user-1");
    c.dispose();
  });

  it("verify with the grant withdrawn sends nothing and is not a code attempt", async () => {
    const { permission: dataPermission } = permission();
    const auth = codeAuth();
    const { c } = makeController({ auth, host: { dataPermission } });
    await c.signIn("me@example.com");
    dataPermission.set("email", false);
    await c.verifyCode("123456");
    expect(auth.verifyCode).not.toHaveBeenCalled();
    expect(c.userId).toBeNull();
    expect(c.authFlow).toBe("code-entry");
    expect(c.codeErrorKind).toBeNull();
    expect(c.dataPermissionNotice).toBe("email");
    c.dispose();
  });

  it("a withdrawn grant reported by the host shows the line; signing in again clears it", async () => {
    const { permission: dataPermission } = permission();
    const { c } = makeController({ auth: codeAuth(), host: { dataPermission } });
    c.showDataPermissionNotice("email");
    expect(c.dataPermissionNotice).toBe("email");
    await c.signIn("me@example.com");
    await c.verifyCode("123456");
    expect(c.userId).toBe("user-1");
    expect(c.dataPermissionNotice).toBeNull();
    c.dispose();
  });

  it("Chrome, Safari and the Apple app (no DataPermission) send without asking anything", async () => {
    const auth = codeAuth();
    const { c } = makeController({ auth });
    await c.signIn("me@example.com");
    expect(auth.requestCode).toHaveBeenCalledOnce();
    expect(c.dataPermissionNotice).toBeNull();
    c.dispose();
  });
});

describe("purchase: Still Pro's purchase status is checked only with Firefox's permission", () => {
  it("Get Still Pro asks inside the tap first; declined starts no checkout", async () => {
    const { permission: dataPermission, log } = permission({ purchase: false });
    const { seam } = checkoutSeam();
    const { c } = makeController({ auth: codeAuth(), checkout: seam, host: { dataPermission } });
    c.userId = "user-1";
    const pending = c.startWebCheckout();
    expect(log).toEqual(["ask:purchase"]);
    await pending;
    expect(seam.createCheckout).not.toHaveBeenCalled();
    expect(c.purchaseFlow).toBe("failed");
    expect(c.purchaseError).toBe(DATA_PERMISSION_COPY.purchase);
    expect(c.purchaseBusy).toBe(false);
  });

  it("granted: the checkout starts as before", async () => {
    const { permission: dataPermission } = permission();
    const { seam } = checkoutSeam();
    const { c } = makeController({ auth: codeAuth(), checkout: seam, host: { dataPermission } });
    c.userId = "user-1";
    await c.startWebCheckout();
    expect(seam.createCheckout).toHaveBeenCalledOnce();
  });
});

describe("the sign-in sheet's line", () => {
  it("shows the minimal line where the person clicked Send code", async () => {
    const { permission: dataPermission } = permission({ email: false });
    const auth = codeAuth();
    const { c } = makeController({ auth, host: { canPurchase: false, dataPermission } });
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    const input = document.querySelector("input.email") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "me@example.com" } });
    await fireEvent.click(screen.getByText(STRINGS.codeAuth.send));
    await settle();
    await tick();
    expect(screen.getByText(DATA_PERMISSION_COPY.email)).toBeTruthy();
    expect(auth.requestCode).not.toHaveBeenCalled();
  });
});
