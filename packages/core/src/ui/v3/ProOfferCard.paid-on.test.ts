import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

// The checkout-priced browser offer only exists in builds compiled with the paid tier on.
vi.mock("@still/shared-types", async (original) => ({
  ...(await original<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import ProOfferCard from "./ProOfferCard.svelte";
import type { ProOfferCardProps } from "./extension-settings-presentation.js";

afterEach(cleanup);

const CHECKOUT_PRICED = { price: "", checkoutPriced: true } as const;

function props(overrides: Partial<ProOfferCardProps & { knownMissing: boolean }> = {}) {
  return {
    ownership: "none" as const,
    channel: "ready" as const,
    offer: CHECKOUT_PRICED,
    knownMissing: true,
    confirmedAccount: true,
    onBuy: vi.fn(),
    onSignIn: vi.fn(),
    onRestore: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

describe("checkout-priced browser offer (paid tier compiled on)", () => {
  it("enables Buy with no price on the card and says the checkout shows it", async () => {
    const input = props();
    render(ProOfferCard, { props: input });
    const card = screen.getByRole("region", { name: "Still Pro" });
    expect(within(card).getByText("The price is shown at checkout.")).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/\$|\d+\.\d\d/);
    await fireEvent.click(within(card).getByRole("button", { name: "Get Still Pro" }));
    expect(input.onBuy).toHaveBeenCalledOnce();
  });

  it.each([
    ["access not known none", { knownMissing: false }],
    ["channel unverified", { channel: "unverified" as const }],
    ["channel unavailable", { channel: "unavailable" as const }],
    ["the browser offline", { channel: "offline" as const }],
    ["held access", { accessHeld: true }],
    ["checking access", { accessChecking: true }],
    ["verify access", { accessVerify: true }],
    ["a Restore under way", { restoreHeld: true }],
    ["failed", { state: "failed" as const }],
    ["succeeded", { state: "success" as const }],
    ["no offer", { offer: undefined }],
    ["an offer not marked checkout-priced, with no price", { offer: { price: "" } }],
    ["an offer marked anything but true", { offer: { price: " ", checkoutPriced: "yes" } as unknown as ProOfferCardProps["offer"] }],
  ])("offers no Buy with %s", (_name, overrides) => {
    render(ProOfferCard, { props: props(overrides) });
    expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    expect(screen.queryByText("The price is shown at checkout.")).toBeNull();
  });

  it("keeps the verify, checking and failed presentations unchanged", () => {
    const verify = render(ProOfferCard, { props: props({ ownership: "verify" }) });
    expect(screen.getByText("Still Pro needs to be verified again.")).toBeInTheDocument();
    verify.unmount();
    const checking = render(ProOfferCard, { props: props({ ownership: "checking" }) });
    expect(screen.getByText("Checking your Still Pro access…")).toBeInTheDocument();
    checking.unmount();
    render(ProOfferCard, { props: props({ state: "failed" }) });
    expect(screen.getByText("The purchase wasn't confirmed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  describe("offline (ISS-0090)", () => {
    it("says Still can't check right now, not that Still Pro can't be bought here", () => {
      render(ProOfferCard, { props: props({ channel: "offline" }) });
      const card = screen.getByRole("region", { name: "Still Pro" });
      expect(within(card).getByText("Still can't check right now.")).toBeVisible();
      expect(within(card).getByText("Try again when you're online.")).toBeVisible();
      expect(within(card).queryByText("Still Pro can't be bought here yet.")).toBeNull();
      expect(within(card).getByRole("button", { name: "Restore purchase" })).toBeEnabled();
    });

    it("a known none the host keeps through an offline hold says the same, never verify again", () => {
      render(ProOfferCard, { props: props({ channel: "offline", accessHeld: true, accessVerify: true }) });
      expect(screen.getByText("Still can't check right now.")).toBeVisible();
      expect(screen.queryByText("Still Pro needs to be verified again.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    });

    it("an answer that needs verifying still says verify again", () => {
      render(ProOfferCard, { props: props({ ownership: "verify", channel: "offline", accessVerify: true }) });
      expect(screen.getByText("Still Pro needs to be verified again.")).toBeVisible();
      expect(screen.queryByText("Still can't check right now.")).toBeNull();
    });

    it("keeps that line through a Restore check, never flashing verify again", () => {
      render(ProOfferCard, {
        props: props({ channel: "offline", accessHeld: true, accessVerify: true, restoreHeld: true }),
      });
      expect(screen.getByText("Still can't check right now.")).toBeVisible();
      expect(screen.queryByText("Still Pro needs to be verified again.")).toBeNull();
      expect(screen.queryByText("Still Pro can't be bought here yet.")).toBeNull();
      expect(screen.getByRole("button", { name: "Restore purchase" })).toBeDisabled();
    });
  });

  it("shows the waiting state while the checkout is open", () => {
    render(ProOfferCard, { props: props({ state: "pending" }) });
    expect(screen.getByRole("button", { name: "Waiting for checkout…" })).toBeDisabled();
  });

  it("signed out, the same button asks for sign-in first", async () => {
    const input = props({ confirmedAccount: false });
    render(ProOfferCard, { props: input });
    await fireEvent.click(screen.getByRole("button", { name: "Get Still Pro" }));
    expect(input.onSignIn).toHaveBeenCalledOnce();
    expect(input.onBuy).not.toHaveBeenCalled();
  });

  it("leaves the verified-price path as it was", () => {
    render(ProOfferCard, { props: props({ offer: { price: "$fixture", priceNote: "Localized lifetime terms" } }) });
    expect(screen.getByText("Localized lifetime terms")).toBeInTheDocument();
    expect(screen.queryByText("The price is shown at checkout.")).toBeNull();
    expect(screen.getByRole("button", { name: "Get Still Pro" })).toBeInTheDocument();
  });
});
