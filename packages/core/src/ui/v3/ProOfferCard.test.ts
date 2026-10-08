import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProOfferCard from "./ProOfferCard.svelte";
import type { ProOfferCardProps } from "./extension-settings-presentation.js";

afterEach(cleanup);
function props(
  overrides: Partial<ProOfferCardProps & { knownMissing: boolean }> = {},
) {
  return {
    ownership: "none" as const,
    channel: "ready" as const,
    controls: [
      { site: "YouTube", label: "Comments" },
      { site: "Instagram", label: "Stories and Highlights" },
    ],
    offer: { price: "$fixture-price", priceNote: "Localized lifetime terms" },
    knownMissing: true,
    confirmedAccount: true,
    onBuy: vi.fn(),
    onSignIn: vi.fn(),
    onRestore: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

describe("browser Pro offer static list and existing authority", () => {
  it("describes controls without switches, exposing the price only in checkout", async () => {
    const input = props();
    render(ProOfferCard, { props: input });
    const card = screen.getByRole("region", { name: "Still Pro" });
    expect(
      within(card)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Comments", "Stories and Highlights"]);
    expect(within(card).queryByRole("switch")).toBeNull();
    expect(screen.queryByText("$fixture-price")).toBeNull();
    expect(input.onBuy).not.toHaveBeenCalled();
    await fireEvent.click(
      screen.getByRole("button", { name: "Get Still Pro" }),
    );
    expect(input.onBuy).toHaveBeenCalledOnce();
    expect(input.onSignIn).not.toHaveBeenCalled();
  });

  it("uses the current account confirmation and caller action after rerender", async () => {
    const input = props({ confirmedAccount: false });
    const view = render(ProOfferCard, { props: input });
    await fireEvent.click(
      screen.getByRole("button", { name: "Get Still Pro" }),
    );
    expect(input.onSignIn).toHaveBeenCalledOnce();
    expect(input.onBuy).not.toHaveBeenCalled();
    const current = vi.fn();
    await view.rerender({ ...input, confirmedAccount: true, onBuy: current });
    await fireEvent.click(
      screen.getByRole("button", { name: "Get Still Pro" }),
    );
    expect(current).toHaveBeenCalledOnce();
    expect(input.onBuy).not.toHaveBeenCalled();
  });

  it.each(["owned", "checking"] as const)(
    "keeps %s presentation free of the sales list and Buy",
    (ownership) => {
      render(ProOfferCard, { props: props({ ownership }) });
      expect(screen.queryByRole("listitem")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Get Still Pro" }),
      ).toBeNull();
    },
  );

  it.each([
    { state: "failed" },
    { state: "success" },
    { ownership: "failed" },
    { ownership: "verify" },
    { knownMissing: false },
    { accessHeld: true },
    { accessVerify: true },
    { restoreHeld: true },
    { channel: "unverified" },
    { channel: "unavailable" },
    { offer: undefined },
    { offer: { price: " " } },
  ] satisfies Partial<ProOfferCardProps & { knownMissing: boolean }>[])(
    "keeps Buy held with current unavailable authority %j despite the descriptive list",
    (held) => {
      const input = props(held);
      render(ProOfferCard, { props: input });
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
      expect(
        screen.queryByRole("button", { name: "Get Still Pro" }),
      ).toBeNull();
      expect(input.onBuy).not.toHaveBeenCalled();
    },
  );

  it("does not repeat checkout while pending or invent a missing caller action", async () => {
    const input = props({ state: "pending" });
    const view = render(ProOfferCard, { props: input });
    await fireEvent.click(
      screen.getByRole("button", { name: "Waiting for checkout…" }),
    );
    expect(input.onBuy).not.toHaveBeenCalled();
    await view.rerender({ ...input, state: "idle", onBuy: undefined });
    expect(
      screen.getByRole("button", { name: "Get Still Pro" }),
    ).toBeDisabled();
    await fireEvent.click(
      screen.getByRole("button", { name: "Get Still Pro" }),
    );
    expect(input.onBuy).not.toHaveBeenCalled();
  });
});
