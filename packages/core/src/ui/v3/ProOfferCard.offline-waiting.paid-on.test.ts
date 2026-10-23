// Owner rulings B5 and B6 (22 Oct 2026, canvas Chrome-Settings-Offline and Flow-ChromeWaiting): the
// Chrome/Firefox Settings page's Still Pro card, offline or while checkout is open, is only its
// heading, its one line or busy button, and Restore purchase. The checkout-priced offer needs the
// compiled paid flag, so this file replaces that one export (as ExtensionSettings.paid-on.test.ts).
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/svelte";

vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import { fixture } from "./ExtensionSettings.test-fixtures.js";
import ExtensionSettings from "./ExtensionSettings.svelte";

const offer = { price: "", checkoutPriced: true as const, priceLine: "$9.99 · one-time" };

async function card(pro: Record<string, unknown>) {
  const { props } = await fixture("locked");
  render(ExtensionSettings, {
    props: { ...props, sync: { account: { address: "person@still.test", confirmed: true } }, pro: pro as never },
  });
  return within(screen.getByRole("region", { name: "Still Pro" }));
}

describe("Still Pro card, offline and waiting for checkout", () => {
  it("the ordinary offer still leads with what Still Pro hides, the terms and the price line", async () => {
    const view = await card({ ownership: "none", channel: "ready", offer, state: "idle", onBuy: vi.fn(), onRestore: vi.fn() });
    expect(view.getByText("Remove more of what distracts you.")).toBeVisible();
    expect(view.getByRole("list")).toBeVisible();
    expect(view.getByText("One-time purchase. Lifetime access.")).toBeVisible();
    expect(view.getByText("$9.99 · one-time")).toBeVisible();
  });

  it("offline: the heading, the two lines and Restore purchase only", async () => {
    const view = await card({ ownership: "none", channel: "offline", onRestore: vi.fn() });
    expect(view.getByRole("heading", { name: "Still Pro" })).toBeVisible();
    expect(view.getByText(/Still can.t check right now\./)).toBeVisible();
    expect(view.getByText(/Try again when you.re online\./)).toBeVisible();
    expect(view.getByRole("button", { name: "Restore purchase" })).toBeVisible();
    expect(view.queryByText("Remove more of what distracts you.")).toBeNull();
    expect(view.queryByRole("list")).toBeNull();
  });

  it("waiting for checkout: the heading, the busy button and Restore purchase only", async () => {
    const view = await card({ ownership: "none", channel: "ready", offer, state: "pending", onBuy: vi.fn(), onRestore: vi.fn() });
    expect(view.getByRole("heading", { name: "Still Pro" })).toBeVisible();
    const busy = view.getByRole("button", { name: "Waiting for checkout…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(view.getByRole("button", { name: "Restore purchase" })).toBeVisible();
    expect(view.queryByText("Remove more of what distracts you.")).toBeNull();
    expect(view.queryByRole("list")).toBeNull();
    expect(view.queryByText("One-time purchase. Lifetime access.")).toBeNull();
    expect(view.queryByText("$9.99 · one-time")).toBeNull();
  });
});
