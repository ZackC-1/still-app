import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import NativeProOfferCard from "./NativeProOfferCard.svelte";
import ProOfferCard from "./ProOfferCard.svelte";

afterEach(cleanup);

const checking = "Checking your Still Pro access…";
const verify = "Still Pro needs to be verified again.";
// Removed by the owner (ISS-0029 item 6): the verify state is one line plus Restore purchase.
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
      expect(screen.queryByText(verifyDetail)).toBeNull();
      expect(
        section.querySelector(".status-line .status-body")!.textContent!.trim(),
      ).toBe(verify);
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
        screen.getByText("Still Pro can’t be bought here yet."),
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
        screen.getByText("We couldn’t finish checking. Nothing changed."),
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
      expect(screen.getByText("The purchase wasn’t confirmed.")).toBeVisible();
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

  it("a Buy the App Store never started says nothing was charged and keeps Try again (ISS-0070)", async () => {
    const props = native({ state: "failed", notCharged: true });
    const view = render(NativeProOfferCard, { props });
    expect(screen.getByText("Still Pro couldn’t be bought right now.")).toBeVisible();
    expect(
      screen.getByText(
        "Nothing was charged. Make sure you’re signed in to the App Store, then try again.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveAttribute("data-tone", "failed");
    expect(screen.queryByText("The purchase wasn’t confirmed.")).toBeNull();
    expect(screen.queryByText(/If you were charged/)).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onRetry).toHaveBeenCalledOnce();
    view.unmount();
  });
  it("an ambiguous failure without the flag keeps the may-have-been-charged copy", () => {
    const view = render(NativeProOfferCard, { props: native({ state: "failed" }) });
    expect(screen.getByText("The purchase wasn’t confirmed.")).toBeVisible();
    expect(screen.getByText("If you were charged, Restore purchase will find it.")).toBeVisible();
    expect(screen.queryByText("Still Pro couldn’t be bought right now.")).toBeNull();
    view.unmount();
  });
});

// ISS-0132: signed out with a historical purchase, the card holds only the sign-in prompt.
describe("native Still Pro card sign-in to restore", () => {
  const line = "Bought Still Pro before? Sign in to restore it.";
  it("shows only the line and Sign in: no Get Still Pro, no Restore purchase, no verify", async () => {
    const onSignInToRestore = vi.fn();
    const props = native({ onSignInToRestore });
    render(NativeProOfferCard, { props });
    expect(screen.getByText(line)).toBeInTheDocument();
    expect(buy()).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore purchase" })).toBeNull();
    expect(screen.queryByText(verify)).toBeNull();
    expect(screen.queryByText(/One-time purchase/)).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignInToRestore).toHaveBeenCalledOnce();
    expect(props.onBuy).not.toHaveBeenCalled();
    expect(props.onRestore).not.toHaveBeenCalled();
  });
  it("is the ordinary offer without the prompt, and never covers owned or checking", () => {
    const view = render(NativeProOfferCard, { props: native() });
    expect(buy()).toBeInTheDocument();
    expect(screen.queryByText(line)).toBeNull();
    view.unmount();
    for (const overrides of [{ ownership: "owned" as const }, { accessChecking: true }]) {
      const next = render(NativeProOfferCard, { props: native({ ...overrides, onSignInToRestore: vi.fn() }) });
      expect(screen.queryByText(line)).toBeNull();
      expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
      next.unmount();
    }
  });
});
