import { describe, expect, it, vi } from "vitest";
import { createBrowserSettingsRestore, type BrowserRestoreAnswer } from "./browser-settings-restore.js";
import type { RestoreStatusCardProps } from "./extension-settings-presentation.js";
import type { DataPermission, DataPermissionKind } from "../data-permission.js";

// Firefox: "Restore purchase" reads the account's Still Pro purchase status, an optional
// data-collection permission there. The tap asks first (synchronously, inside the click); declined
// sends nothing and the card says why; every check re-reads the grant first.

function permission(initial: boolean) {
  const log: string[] = [];
  let granted = initial;
  const value: DataPermission = {
    ask: vi.fn((kind: DataPermissionKind) => {
      log.push(`ask:${kind}`);
      return Promise.resolve(granted);
    }),
    granted: vi.fn((kind: DataPermissionKind) => {
      log.push(`granted:${kind}`);
      return Promise.resolve(granted);
    }),
  };
  return {
    value,
    log,
    set(next: boolean) {
      granted = next;
    },
  };
}

function harness(grant: ReturnType<typeof permission>, answers: BrowserRestoreAnswer[] = []) {
  const published: (RestoreStatusCardProps | undefined)[] = [];
  const check = vi.fn(async (): Promise<BrowserRestoreAnswer> => {
    grant.log.push("check");
    const next = answers.shift();
    if (next === undefined) throw new Error("unexpected check");
    return next;
  });
  const openSignIn = vi.fn();
  const flow = createBrowserSettingsRestore({
    check,
    openSignIn,
    publish: (restore) => published.push(restore),
    permission: grant.value,
  });
  return { flow, check, openSignIn, published, states: () => published.map((card) => card?.state) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("browser settings Restore on Firefox", () => {
  it("asks inside the tap before anything else, then checks", async () => {
    const grant = permission(true);
    const h = harness(grant, ["entitled"]);
    h.flow.observe({ userId: "user-a", signInOpen: false });
    h.flow.request();
    expect(grant.log).toEqual(["ask:purchase"]);
    await settle();
    expect(h.check).toHaveBeenCalledOnce();
    expect(h.states()).toEqual(["checking", "restored"]);
  });

  it("declined: nothing is checked, and the card says Still Pro needs permission", async () => {
    const grant = permission(false);
    const h = harness(grant);
    h.flow.observe({ userId: "user-a", signInOpen: false });
    h.flow.request();
    await settle();
    expect(h.check).not.toHaveBeenCalled();
    expect(h.states()).toEqual(["permission"]);
    expect(h.flow.busy).toBe(false);
  });

  it("declined while signed out: no sign-in is opened", async () => {
    const grant = permission(false);
    const h = harness(grant);
    h.flow.request();
    await settle();
    expect(h.openSignIn).not.toHaveBeenCalled();
    expect(h.states()).toEqual(["permission"]);
  });

  it("signed out and granted: the check after sign-in re-reads the grant first", async () => {
    const grant = permission(true);
    const h = harness(grant, ["not-entitled"]);
    h.flow.request();
    await settle();
    expect(h.openSignIn).toHaveBeenCalledOnce();
    h.flow.observe({ userId: null, signInOpen: true });
    grant.log.length = 0;
    h.flow.observe({ userId: "user-a", signInOpen: false });
    await settle();
    expect(grant.log).toEqual(["granted:purchase", "check"]);
    expect(h.states()).toEqual(["checking", "nothing"]);
  });

  it("withdrawn between the tap and the check: nothing is sent", async () => {
    const grant = permission(true);
    const h = harness(grant);
    h.flow.request();
    await settle();
    h.flow.observe({ userId: null, signInOpen: true });
    grant.set(false); // withdrawn in about:addons while signing in
    h.flow.observe({ userId: "user-a", signInOpen: false });
    await settle();
    expect(h.check).not.toHaveBeenCalled();
    expect(h.states()).toEqual(["checking", "permission"]);
  });
});
