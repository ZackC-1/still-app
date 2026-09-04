// The paywall sheet's own mechanics, exercised with the paid tier switched ON.
//
// Focus containment, early dismissal and the duplicate-tap guards are properties of the sheet
// component, not of the gate in front of it: a styling or markup pass can break any of them
// without touching a line of monetization code. The shipped build has PAID_TIER_ENABLED false and
// never mounts the sheet, so these cases would go dark exactly while the component is most likely
// to be edited. Replacing that one shared export before App is imported keeps them running.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import { DEFAULT_SETTINGS } from "@still/shared-types";
import App from "../App.svelte";
import { UiController } from "../controller.svelte.js";
import { STRINGS } from "../strings.js";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";

/** A purchase-capable host with no auth wired, which is all these cases need. */
function controller() {
  const initial = { ...DEFAULT_SETTINGS, updatedAt: 1 };
  const cache = new SettingsCache(new InMemoryStorageAdapter(initial), {
    initial,
    now: () => Date.now(),
  });
  return new UiController({ cache, host: { canPurchase: true } });
}

describe("PaywallSheet — sheet mechanics with the paid tier on", () => {
  it("the Get button is disabled while a purchase is in flight (duplicate-tap guard)", async () => {
    const onGet = vi.fn();
    const c = controller();
    c.userId = "u";
    c.openPaywall();
    c.paywallPrice = "$1.99";
    render(App, { props: { controller: c, onGet } });
    const dialog = within(screen.getByRole("dialog"));
    await fireEvent.click(dialog.getByText(/Get Still Pro ·/)); // the paywall CTA (has the price)
    expect(onGet).toHaveBeenCalledOnce();
    const inFlight = dialog.getByText(
      /Completing your purchase/,
    ) as HTMLButtonElement;
    expect(inFlight.disabled).toBe(true);
    await fireEvent.click(inFlight);
    expect(onGet).toHaveBeenCalledOnce(); // second tap ignored (button disabled)
  });

  it("a tap on the payoff dismisses it early", async () => {
    const c = controller();
    c.userId = "u";
    c.openPaywall();
    render(App, { props: { controller: c, onGet: () => {} } });
    c.entitled = true;
    await tick();
    await fireEvent.click(screen.getByText(STRINGS.paywall.unlocked));
    expect(c.paywallOpen).toBe(false);
    expect(c.justUnlocked).toBe(false);
  });

  it("Escape dismisses the payoff early", async () => {
    const c = controller();
    c.userId = "u";
    c.openPaywall();
    render(App, { props: { controller: c, onGet: () => {} } });
    c.entitled = true;
    await tick();
    await fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(c.paywallOpen).toBe(false);
    expect(c.justUnlocked).toBe(false);
  });

  it("the web checkout hand-off renders the transitional line with the CTA disabled (U3→U4 hook)", () => {
    const c = controller();
    c.userId = "u";
    c.openPaywall();
    c.purchaseFlow = "opening-checkout";
    render(App, { props: { controller: c, onGet: () => {} } });
    const cta = within(screen.getByRole("dialog")).getByText(
      STRINGS.paywall.openingCheckout,
    ) as HTMLButtonElement;
    expect(cta.disabled).toBe(true); // busy — no duplicate checkout taps
  });

  it("the paywall Tab cycle skips disabled controls while a purchase is in flight", async () => {
    const c = controller();
    c.userId = "u";
    c.openPaywall();
    c.purchaseFlow = "purchasing"; // Get + Restore render disabled
    render(App, { props: { controller: c, onGet: () => {} } });
    const dialog = screen.getByRole("dialog");
    const dismiss = within(dialog).getByText(
      STRINGS.paywall.dismiss,
    ) as HTMLButtonElement;
    dismiss.focus();
    await fireEvent.keyDown(dialog, { key: "Tab" });
    // Tab from the last control wraps to the first ENABLED focusable — here that is the dismiss
    // button itself (the only enabled control), never the disabled Get/Restore pair.
    expect(document.activeElement).toBe(dismiss);
    expect((document.activeElement as HTMLButtonElement).disabled).toBe(false);
  });

  it("dismissing the paywall restores focus to the trigger that opened it", async () => {
    const c = controller(); // no auth wired → a locked-row tap opens the paywall directly
    render(App, { props: { controller: c } });
    const lock = document.querySelector(".lock") as HTMLButtonElement;
    lock.focus();
    await fireEvent.click(lock);
    expect(c.paywallOpen).toBe(true);
    await tick();
    await fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await tick();
    expect(c.paywallOpen).toBe(false);
    expect(document.activeElement).toBe(lock);
  });

  // ── modal focus containment (the shared trap in focus-trap.ts) ─────────────────────────────────
  // jsdom never blurs a control that becomes disabled, so the Tab case above exercises the trap's
  // !hasAttribute("disabled") filter directly rather than the real-browser blur behavior.
});
