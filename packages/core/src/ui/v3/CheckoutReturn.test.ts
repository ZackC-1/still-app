import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import CheckoutReturn from "./CheckoutReturn.svelte";
import type { CheckoutReturnProps } from "./checkout-return-presentation.js";

afterEach(cleanup);
function fixture(
  overrides: Partial<CheckoutReturnProps> = {},
): CheckoutReturnProps {
  const action = () => ({ requestId: "a", verified: true, onRequest: vi.fn() });
  return {
    requestId: "a",
    outcome: {
      requestId: "a",
      verified: true,
      source: "server",
      state: "ready",
    },
    settings: action(),
    support: action(),
    privacy: action(),
    retry: { ...action(), pending: false },
    ...overrides,
  };
}
const open = () =>
  screen.queryByRole("button", { name: "Open Still settings" });
describe("controlled D20 checkout return", () => {
  it("renders verified current server confirmation and requests settings without changing the outcome", async () => {
    const props = fixture();
    render(CheckoutReturn, { props });
    expect(
      screen.getByRole("heading", { name: "Thanks for purchasing Still Pro" }),
    ).toBeTruthy();
    await fireEvent.click(open()!);
    expect(props.settings!.onRequest).toHaveBeenCalledOnce();
    expect(screen.getByText("Still Pro is ready.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    expect(screen.queryByText(/Demonstration only/)).toBeNull();
  });
  for (const overrides of [
    { outcome: undefined },
    {
      outcome: {
        requestId: "a",
        verified: false,
        source: "server",
        state: "ready",
      },
    },
    {
      outcome: {
        requestId: "old",
        verified: true,
        source: "server",
        state: "ready",
      },
    },
    {
      requestId: " ",
      outcome: {
        requestId: " ",
        verified: true,
        source: "server",
        state: "ready",
      },
    },
    {
      outcome: {
        requestId: "a",
        verified: true,
        source: "unknown",
        state: "unknown",
      },
    },
  ] satisfies Partial<CheckoutReturnProps>[]) {
    it("cannot request settings or announce success from an unverified, stale or unknown outcome", async () => {
      const props = fixture(overrides);
      render(CheckoutReturn, { props });
      const button = open();
      if (button) await fireEvent.click(button);
      expect(props.settings!.onRequest).not.toHaveBeenCalled();
      expect(open()).toBeNull();
      expect(screen.queryByText("Still Pro is ready.")).toBeNull();
      expect(
        screen.queryByText(
          "Nothing was bought. You can try again from Still settings.",
        ),
      ).toBeNull();
      expect(
        screen.getByText("We couldn't confirm your payment yet."),
      ).toBeTruthy();
    });
  }
  it("keeps confirming distinct from a completed purchase or a retry", () => {
    render(CheckoutReturn, {
      props: fixture({
        outcome: {
          requestId: "a",
          verified: true,
          source: "server",
          state: "confirming",
        },
      }),
    });
    expect(screen.getByText("Confirming your purchase…")).toBeTruthy();
    expect(open()).toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });
  it("shows cancellation only from current verified provider confirmation", () => {
    render(CheckoutReturn, {
      props: fixture({
        outcome: {
          requestId: "a",
          verified: true,
          source: "provider",
          state: "cancelled",
        },
      }),
    });
    expect(
      screen.getByText(
        "Nothing was bought. You can try again from Still settings.",
      ),
    ).toBeTruthy();
    expect(open()).toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
  });
  for (const outcome of [
    { requestId: "a", verified: false, source: "provider", state: "cancelled" },
    {
      requestId: "old",
      verified: true,
      source: "provider",
      state: "cancelled",
    },
    { requestId: "a", verified: true, source: "unknown", state: "unknown" },
  ] satisfies NonNullable<CheckoutReturnProps["outcome"]>[]) {
    it("does not give a cancellation assurance for an unverified or stale result", () => {
      render(CheckoutReturn, { props: fixture({ outcome }) });
      expect(screen.queryByText("Checkout was cancelled.")).toBeNull();
      expect(
        screen.queryByText(
          "Nothing was bought. You can try again from Still settings.",
        ),
      ).toBeNull();
    });
  }
  it("uses the current settings callback and withdraws it with replacement outcome", async () => {
    const props = fixture(),
      current = vi.fn(),
      view = render(CheckoutReturn, { props });
    await view.rerender({
      ...props,
      settings: { requestId: "a", verified: true, onRequest: current },
    });
    await fireEvent.click(open()!);
    expect(current).toHaveBeenCalledOnce();
    expect(props.settings!.onRequest).not.toHaveBeenCalled();
    await view.rerender({
      ...props,
      outcome: {
        requestId: "a",
        verified: true,
        source: "server",
        state: "unconfirmed",
      },
    });
    expect(open()).toBeNull();
    expect(
      screen.getByText("We couldn't confirm your payment yet."),
    ).toBeTruthy();
    await view.rerender({ ...props, requestId: "b" });
    expect(open()).toBeNull();
    await view.rerender({
      ...props,
      outcome: {
        requestId: "a",
        verified: true,
        source: "server",
        state: "confirming",
      },
    });
    expect(open()).toBeNull();
  });
  for (const settings of [
    undefined,
    { requestId: "old", verified: true, onRequest: vi.fn() },
    { requestId: "a", verified: false, onRequest: vi.fn() },
    { requestId: "a", verified: true },
  ]) {
    it("holds a missing, unverified or stale settings destination", async () => {
      render(CheckoutReturn, { props: fixture({ settings }) });
      expect(open()).toBeDisabled();
      await fireEvent.click(open()!);
      if (settings?.onRequest)
        expect(settings.onRequest).not.toHaveBeenCalled();
    });
  }
  it("requests retry only for a current server-unconfirmed result and holds repeated pending requests", async () => {
    const props = fixture({
        outcome: {
          requestId: "a",
          verified: true,
          source: "server",
          state: "unconfirmed",
        },
      }),
      view = render(CheckoutReturn, { props });
    await fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(props.retry!.onRequest).toHaveBeenCalledOnce();
    expect(
      screen.getByText("We couldn't confirm your payment yet."),
    ).toBeTruthy();
    await view.rerender({
      ...props,
      retry: { ...props.retry!, pending: true },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(props.retry!.onRequest).toHaveBeenCalledOnce();
    expect(open()).toBeNull();
    expect(screen.queryByText("Still Pro is ready.")).toBeNull();
  });
  for (const overrides of [
    {
      outcome: {
        requestId: "a",
        verified: false,
        source: "server",
        state: "unconfirmed",
      },
    },
    {
      outcome: {
        requestId: "old",
        verified: true,
        source: "server",
        state: "unconfirmed",
      },
    },
    {
      retry: {
        requestId: "old",
        verified: true,
        pending: false,
        onRequest: vi.fn(),
      },
    },
    {
      retry: {
        requestId: "a",
        verified: false,
        pending: false,
        onRequest: vi.fn(),
      },
    },
    { retry: undefined },
  ] satisfies Partial<CheckoutReturnProps>[]) {
    it("cannot request retry from stale or unverified current authority", async () => {
      const props = fixture({
        outcome: {
          requestId: "a",
          verified: true,
          source: "server",
          state: "unconfirmed",
        },
        ...overrides,
      });
      render(CheckoutReturn, { props });
      const retry = screen.getByRole("button", { name: "Check again" });
      await fireEvent.click(retry);
      if (props.retry?.onRequest)
        expect(props.retry.onRequest).not.toHaveBeenCalled();
      expect(retry).toHaveAttribute("aria-disabled", "true");
    });
  }
  it("uses replacement retry capability and never changes the outcome itself", async () => {
    const props = fixture({
        outcome: {
          requestId: "a",
          verified: true,
          source: "server",
          state: "unconfirmed",
        },
      }),
      current = vi.fn(),
      view = render(CheckoutReturn, { props });
    await view.rerender({
      ...props,
      retry: {
        requestId: "a",
        verified: true,
        pending: false,
        onRequest: current,
      },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(current).toHaveBeenCalledOnce();
    expect(props.retry!.onRequest).not.toHaveBeenCalled();
    expect(
      screen.getByText("We couldn't confirm your payment yet."),
    ).toBeTruthy();
  });
  it("keeps footer capabilities independent of purchase confirmation and uses current callbacks", async () => {
    const props = fixture({ outcome: undefined }),
      current = vi.fn(),
      view = render(CheckoutReturn, { props });
    await view.rerender({
      ...props,
      support: { requestId: "a", verified: true, onRequest: current },
    });
    await fireEvent.click(
      screen.getByRole("button", { name: "Contact support" }),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: "Privacy policy" }),
    );
    expect(current).toHaveBeenCalledOnce();
    expect(props.support!.onRequest).not.toHaveBeenCalled();
    expect(props.privacy!.onRequest).toHaveBeenCalledOnce();
  });
  it("holds unknown or stale footer destinations without default URLs", async () => {
    const props = fixture({
      support: undefined,
      privacy: { requestId: "old", verified: true, onRequest: vi.fn() },
    });
    render(CheckoutReturn, { props });
    const support = screen.getByRole("button", { name: "Contact support" }),
      privacy = screen.getByRole("button", { name: "Privacy policy" });
    expect(support).toBeDisabled();
    expect(privacy).toBeDisabled();
    await fireEvent.click(privacy);
    expect(props.privacy!.onRequest).not.toHaveBeenCalled();
    expect(document.querySelectorAll("a[href]")).toHaveLength(0);
  });
  it("renders and unmounts without requesting any operation or enabling settings", () => {
    const props = fixture(),
      view = render(CheckoutReturn, { props });
    view.unmount();
    for (const action of [
      props.settings,
      props.support,
      props.privacy,
      props.retry,
    ])
      expect(action!.onRequest).not.toHaveBeenCalled();
  });
});
