// The sync card's entitlement-flavoured states, exercised with the paid tier switched ON.
//
// Three of the card's states exist only to describe what a purchase did or did not grant:
// `pro-no-account` (this device owns Pro but there is no account), `not-entitled` (an account that
// has not bought), and `pro-device-only` (an account whose Pro comes from the receipt alone, so it
// must never claim sync). With every service included they are unreachable, which is exactly when
// their behaviour is most likely to be broken by an unrelated edit. Replacing the one shared
// switch before the components are imported keeps them running on every build.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";

vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import { DEFAULT_SETTINGS, PAID_TIER_ENABLED } from "@still/shared-types";
import App from "../App.svelte";
import { UiController, type UiAuth } from "../controller.svelte.js";
import { STRINGS } from "../strings.js";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";

function codeCapableAuth(): UiAuth {
  return {
    signOut: () => Promise.resolve(),
    requestCode: () => Promise.resolve({ kind: "sent" } as const),
    verifyCode: () => Promise.resolve({ kind: "verified", userId: "u" } as const),
  };
}

function controller() {
  const initial = { ...DEFAULT_SETTINGS, updatedAt: 1 };
  const cache = new SettingsCache(new InMemoryStorageAdapter(initial), {
    initial,
    now: () => Date.now(),
  });
  return new UiController({ cache, host: { canPurchase: true }, auth: codeCapableAuth() });
}

describe("the sync card with the paid tier on", () => {
  it("the switch this file flips is really on", () => {
    expect(PAID_TIER_ENABLED).toBe(true);
  });

  it("walks the full popup state matrix, including the three entitlement states", () => {
    const c = controller();
    expect(c.popupState).toBe("signed-out");
    c.receiptEntitled = true;
    expect(c.popupState).toBe("pro-no-account");
    c.receiptEntitled = false;
    c.userId = "u";
    c.reconciling = true;
    expect(c.popupState).toBe("entitlement-pending");
    c.reconciling = false;
    expect(c.popupState).toBe("not-entitled");
    c.receiptEntitled = true; // device Pro, account not entitled
    expect(c.popupState).toBe("pro-device-only");
    c.entitled = true;
    expect(c.popupState).toBe("entitled-syncing");
    c.cloudReachable = false;
    expect(c.popupState).toBe("cloud-unreachable");
  });

  it("pro-no-account: says Pro is active, offers sign-in, and never offers a purchase", () => {
    const c = controller();
    c.receiptEntitled = true; // receipt-proven Pro, no session
    render(App, { props: { controller: c } });
    expect(screen.getByText(STRINGS.proNoAccount.active)).toBeTruthy();
    expect(screen.getByText(STRINGS.auth.signInCta)).toBeTruthy();
    expect(screen.queryByText(STRINGS.paywall.upgradeCta)).toBeNull();
    expect(screen.getByText(STRINGS.paywall.restoreSignedOut)).toBeTruthy();
  });

  it("not-entitled: a signed-in account that has not bought is offered the upgrade", () => {
    const c = controller();
    c.userId = "u";
    render(App, { props: { controller: c } });
    expect(c.popupState).toBe("not-entitled");
    expect(screen.getByText(STRINGS.paywall.upgradeCta)).toBeTruthy();
    expect(screen.getByText(STRINGS.auth.signOut)).toBeTruthy();
  });

  it("pro-device-only: receipt-only Pro never claims a sync it does not have", () => {
    const c = controller();
    c.userId = "u1";
    c.receiptEntitled = true; // server lane false: attach ineligible or the webhook has not landed
    render(App, { props: { controller: c } });
    expect(c.popupState).toBe("pro-device-only");
    expect(screen.getByText(STRINGS.proNoAccount.active)).toBeTruthy();
    expect(screen.queryByText(STRINGS.sync.syncing)).toBeNull();
    expect(screen.getByText(STRINGS.auth.signOut)).toBeTruthy();
  });

  it("the hero says what the included tier removes and what the paid one adds", () => {
    const c = controller();
    render(App, { props: { controller: c } });
    expect(screen.getByText(STRINGS.global.onFree)).toBeTruthy();
  });
});
