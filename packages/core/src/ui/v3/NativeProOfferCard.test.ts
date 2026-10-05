import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import NativeProOfferCard from "./NativeProOfferCard.svelte";
import ProOfferCard from "./ProOfferCard.svelte";

afterEach(cleanup);

const checking = "Checking your Still Pro access…";
const verify = "Still Pro needs to be verified again.";
const verifyDetail =
  "Go online and sign in. Free controls and your saved choices stay.";
const buy = () => screen.queryByRole("button", { name: "Get Still Pro" });

function native(overrides: Record<string, unknown> = {}) {
  return {
    ownership: "none" as const,
    channel: "ready" as const,
    offer: { price: "fixture native offer" },
    onBuy: vi.fn(),
    onRestore: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

/** The verify status line exactly as the browser card on main renders it. */
function browserVerifyLine(observation: "ownership" | "access") {
  const view = render(ProOfferCard, {
    props: {
      ownership: observation === "ownership" ? "verify" : "none",
      channel: "ready",
      offer: { price: "fixture browser offer" },
      confirmedAccount: true,
      knownMissing: false,
      accessHeld: observation === "access",
      accessVerify: observation === "access",
      onBuy: vi.fn(),
      onRestore: vi.fn(),
    },
  });
  const section = view.container.querySelector("section")!;
  const markup = {
    head: section.querySelector(".offer-head")!.outerHTML,
    line: section.querySelector(".status-line")!.outerHTML,
  };
  view.unmount();
  return markup;
}

describe("native Still Pro card verify presentation", () => {
  it.each(["ownership", "access"] as const)(
    "mirrors the browser card's verify presentation for a %s verify observation",
    (observation) => {
      const expected = browserVerifyLine(observation);
      const view = render(NativeProOfferCard, {
        props: native(
          observation === "ownership"
            ? { ownership: "verify" }
            : { accessHeld: true, accessVerify: true },
        ),
      });
      const section = view.container.querySelector("section")!;
      expect(section.querySelector(".offer-head")!.outerHTML).toBe(
        expected.head,
      );
      expect(section.querySelector(".status-line")!.outerHTML).toBe(
        expected.line,
      );
      expect(screen.getByText(verify)).toBeVisible();
      expect(screen.getByText(verifyDetail)).toBeVisible();
      expect(screen.queryByText(checking)).toBeNull();
      expect(buy()).toBeNull();
      expect(
        screen.getByRole("button", { name: "Restore purchase" }),
      ).toBeEnabled();
      view.unmount();
    },
  );

  it("never offers Buy while a verify observation is held", async () => {
    const props = native({ accessVerify: true });
    const view = render(NativeProOfferCard, { props });
    expect(buy()).toBeNull();
    expect(screen.getByText(verify)).toBeVisible();
    expect(props.onBuy).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps checking ahead of verify when both observations are held, as the browser card does", () => {
    const browser = render(ProOfferCard, {
      props: {
        ownership: "none",
        channel: "ready",
        offer: { price: "fixture browser offer" },
        confirmedAccount: true,
        knownMissing: false,
        accessHeld: true,
        accessChecking: true,
        accessVerify: true,
      },
    });
    expect(screen.getByText(checking)).toBeVisible();
    browser.unmount();
    const view = render(NativeProOfferCard, {
      props: native({
        accessHeld: true,
        accessChecking: true,
        accessVerify: true,
      }),
    });
    expect(screen.getByText(checking)).toBeVisible();
    expect(screen.queryByText(verify)).toBeNull();
    expect(buy()).toBeNull();
    view.unmount();
  });

  it("still shows checking for a held access without a verify observation", () => {
    const view = render(NativeProOfferCard, {
      props: native({ accessHeld: true }),
    });
    expect(screen.getByText(checking)).toBeVisible();
    expect(screen.queryByText(verify)).toBeNull();
    expect(buy()).toBeNull();
    view.unmount();
  });
});

describe("native Still Pro card price gate", () => {
  it.each(["", "   ", "\n\t"])(
    "withholds Buy and retry for a blank offer price %j, as the browser card does",
    async (price) => {
      const props = native({ offer: { price } });
      const view = render(NativeProOfferCard, { props });
      expect(buy()).toBeNull();
      expect(
        screen.getByText("Still Pro can't be bought here yet."),
      ).toBeVisible();
      await view.rerender({ ...props, state: "failed" });
      const retry = screen.getByRole("button", { name: "Try again" });
      expect(retry).toBeDisabled();
      await fireEvent.click(retry);
      expect(props.onRetry).not.toHaveBeenCalled();
      expect(props.onBuy).not.toHaveBeenCalled();
      view.unmount();
    },
  );

  it("offers Buy for a priced offer with surrounding whitespace", async () => {
    const props = native({ offer: { price: "  fixture native offer  " } });
    const view = render(NativeProOfferCard, { props });
    await fireEvent.click(buy()!);
    expect(props.onBuy).toHaveBeenCalledOnce();
    view.unmount();
  });
});

describe("native Still Pro card checking condition", () => {
  const ownerships = ["none", "checking", "verify", "failed"] as const;
  const states = ["idle", "pending", "failed", "success"] as const;
  const cases = ownerships.flatMap((ownership) =>
    states.flatMap((state) =>
      [false, true].map((accessChecking) => ({
        ownership,
        state,
        accessChecking,
      })),
    ),
  );

  it.each(cases)(
    "shows the checking spinner exactly when the browser card does (ownership $ownership, state $state, accessChecking $accessChecking)",
    ({ ownership, state, accessChecking }) => {
      const browser = render(ProOfferCard, {
        props: {
          ownership,
          state,
          accessChecking,
          channel: "ready",
          offer: { price: "fixture browser offer" },
          confirmedAccount: true,
          knownMissing: true,
          onBuy: vi.fn(),
          onRestore: vi.fn(),
        },
      });
      const expected = screen.queryByText(checking) !== null;
      browser.unmount();
      const view = render(NativeProOfferCard, {
        props: native({ ownership, state, accessChecking }),
      });
      expect(screen.queryByText(checking) !== null).toBe(expected);
      view.unmount();
    },
  );

  it.each([
    {
      held: { accessChecking: true },
      label: "a checking observation",
    },
    { held: { accessHeld: true }, label: "a residual held access" },
  ])(
    "shows a failed ownership check, not the spinner, with $label",
    ({ held }) => {
      const props = native({ ownership: "failed", ...held });
      const view = render(NativeProOfferCard, { props });
      expect(
        screen.getByText("We couldn't finish checking. Nothing changed."),
      ).toBeVisible();
      expect(screen.getByRole("alert")).toHaveAttribute("data-tone", "failed");
      expect(screen.queryByText(checking)).toBeNull();
      expect(buy()).toBeNull();
      view.unmount();
    },
  );

  it.each([
    { held: { accessChecking: true }, label: "a checking observation" },
    { held: { accessHeld: true }, label: "a residual held access" },
    { held: { ownership: "checking" }, label: "checking ownership" },
  ])(
    "shows an unconfirmed purchase, not the spinner, with $label and never retries while held",
    async ({ held }) => {
      const props = native({ state: "failed", ...held });
      const view = render(NativeProOfferCard, { props });
      expect(screen.getByText("The purchase wasn't confirmed.")).toBeVisible();
      expect(screen.queryByText(checking)).toBeNull();
      expect(buy()).toBeNull();
      const retry = screen.getByRole("button", { name: "Try again" });
      expect(retry).toBeDisabled();
      await fireEvent.click(retry);
      expect(props.onRetry).not.toHaveBeenCalled();
      expect(props.onBuy).not.toHaveBeenCalled();
      view.unmount();
    },
  );
});
