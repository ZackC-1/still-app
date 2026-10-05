import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import PurchaseView from "./PurchaseView.svelte";
import type { PurchaseViewProps } from "./purchase-presentation.js";

afterEach(cleanup);
const controls = [
  { site: "YouTube", label: "Comments" },
  { site: "Instagram", label: "Stories and Highlights" },
];
type BrowserProps = Extract<PurchaseViewProps, { host: "browser" }>;
type AppleProps = Extract<PurchaseViewProps, { host: "apple" }>;
function browser(overrides: Partial<BrowserProps> = {}): BrowserProps {
  return {
    host: "browser",
    controls,
    access: { state: "none", verified: true },
    channel: "ready",
    offer: { price: "verified fixture", verified: true },
    purchase: { state: "idle" },
    checkout: { verified: true, onRequest: vi.fn() },
    restorePort: { verified: true, onRequest: vi.fn() },
    onSignIn: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  } as BrowserProps;
}
function apple(overrides: Partial<AppleProps> = {}): AppleProps {
  return {
    host: "apple",
    controls,
    access: { state: "none", verified: true },
    channel: "ready",
    offer: { price: "verified fixture", verified: true },
    purchase: { state: "idle" },
    native: { verified: true, onBuy: vi.fn(), onRestore: vi.fn() },
    onBack: vi.fn(),
    ...overrides,
  } as AppleProps;
}
const buy = () => screen.queryByRole("button", { name: "Get Still Pro" });
describe("controlled D18 purchase view", () => {
  it("requests purchase sign-in without starting checkout or inventing success", async () => {
    const props = browser();
    render(PurchaseView, { props });
    await fireEvent.click(buy()!);
    if (props.host !== "browser") throw new Error("fixture");
    expect(props.onSignIn).toHaveBeenCalledWith("purchase");
    expect(props.checkout.onRequest).not.toHaveBeenCalled();
    expect(screen.queryByText("Still Pro is ready.")).toBeNull();
    expect(buy()).not.toBeNull();
  });
  it("uses current confirmed account and current checkout callback across rerenders", async () => {
    const old = vi.fn(),
      current = vi.fn(),
      props = browser({
        account: { id: "a", confirmed: true },
        checkout: { verified: true, onRequest: old },
      });
    const view = render(PurchaseView, { props });
    await view.rerender({
      ...props,
      account: { id: "b", confirmed: true },
      checkout: { verified: true, onRequest: current },
    });
    await fireEvent.click(buy()!);
    expect(current).toHaveBeenCalledOnce();
    expect(old).not.toHaveBeenCalled();
    await view.rerender({
      ...props,
      account: { id: "b", confirmed: false },
      checkout: { verified: true, onRequest: current },
    });
    await fireEvent.click(buy()!);
    expect(current).toHaveBeenCalledOnce();
    if (props.host === "browser")
      expect(props.onSignIn).toHaveBeenCalledWith("purchase");
  });
  it("does not treat an empty account identity as confirmation", async () => {
    const props = browser({ account: { id: " ", confirmed: true } });
    render(PurchaseView, { props });
    await fireEvent.click(buy()!);
    if (props.host === "browser") {
      expect(props.checkout.onRequest).not.toHaveBeenCalled();
      expect(props.onSignIn).toHaveBeenCalledWith("purchase");
    }
  });
  it("allows trusted Apple purchase and Restore without a Still account", async () => {
    const props = apple();
    render(PurchaseView, { props });
    await fireEvent.click(buy()!);
    await fireEvent.click(
      screen.getByRole("button", { name: "Restore purchase" }),
    );
    if (props.host === "apple") {
      expect(props.native.onBuy).toHaveBeenCalledOnce();
      expect(props.native.onRestore).toHaveBeenCalledOnce();
    }
    expect(
      screen.getByText("Payment is handled by Apple. No account needed."),
    ).toBeTruthy();
  });
  for (const state of [
    "owned",
    "purchased",
    "protected",
    "free",
    "checking",
    "verify",
    "failed",
    "unknown",
  ] as const) {
    it(`holds acquisition for actual ${state} access`, () => {
      render(PurchaseView, {
        props: browser({ access: { state, verified: true } }),
      });
      expect(buy()).toBeNull();
      if (state === "protected" || state === "free")
        expect(screen.queryByText("You have Still Pro.")).toBeNull();
    });
  }
  for (const overrides of [
    { access: { state: "none", verified: false } },
    { channel: "unverified" },
    { channel: "unavailable" },
    { offer: undefined },
    { offer: { price: " ", verified: true } },
    { offer: { price: "fixture", verified: false } },
    { checkout: { verified: false, onRequest: vi.fn() } },
  ] as Partial<BrowserProps>[]) {
    it("holds acquisition without current verified authority", () => {
      render(PurchaseView, { props: browser(overrides) });
      expect(buy()).toBeNull();
    });
  }
  it("holds untrusted native purchase and Restore ports", () => {
    const props = apple({
      native: { verified: false, onBuy: vi.fn(), onRestore: vi.fn() },
    });
    render(PurchaseView, { props });
    expect(buy()).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Restore purchase" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
  it("does not repeat a purchase when caller reports pending", async () => {
    const props = browser({ account: { id: "a", confirmed: true } });
    const view = render(PurchaseView, { props });
    await fireEvent.click(buy()!);
    await view.rerender({ ...props, purchase: { state: "pending" } });
    const waiting = screen.getByRole("button", {
      name: "Waiting for checkout…",
    });
    await fireEvent.click(waiting);
    if (props.host === "browser")
      expect(props.checkout.onRequest).toHaveBeenCalledOnce();
    expect(buy()).toBeNull();
    expect(screen.queryByText("Still Pro is ready.")).toBeNull();
  });
  it("does not infer ready from an unconfirmed success observation", () => {
    render(PurchaseView, {
      props: browser({ purchase: { state: "success", confirmed: false } }),
    });
    expect(buy()).toBeNull();
    expect(screen.queryByText("Still Pro is ready.")).toBeNull();
  });
  it("renders only caller-confirmed success and preserves navigation", async () => {
    const props = apple({ purchase: { state: "success", confirmed: true } });
    render(PurchaseView, { props });
    expect(screen.getByText("Still Pro is ready.")).toBeTruthy();
    expect(buy()).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Restore purchase" }),
    ).toBeNull();
    await fireEvent.click(
      screen.getByRole("button", { name: "Back to settings" }),
    );
    expect(props.onBack).toHaveBeenCalledOnce();
  });
  for (const state of [
    "checking",
    "verify",
    "failed",
    "restored",
    "unknown",
  ] as const) {
    it(`holds selling during Restore ${state}`, async () => {
      const onAction = vi.fn();
      render(PurchaseView, {
        props: browser({
          restore: { state, verified: true, conclusive: true, onAction },
        }),
      });
      expect(buy()).toBeNull();
      if (state === "verify" || state === "failed") {
        await fireEvent.click(
          screen.getByRole("button", {
            name: state === "verify" ? "Verify now" : "Try again",
          }),
        );
        expect(onAction).toHaveBeenCalledOnce();
      }
      expect(
        screen.queryByRole("button", { name: "Restore purchase" }),
      ).toBeNull();
    });
  }
  for (const state of ["nothing", "restored"] as const) {
    it(`requires conclusive Restore ${state}`, () => {
      render(PurchaseView, {
        props: browser({
          restore: { state, verified: true, conclusive: false },
        }),
      });
      expect(buy()).toBeNull();
      expect(
        screen.queryByText(
          state === "nothing"
            ? "No Still Pro purchase was found for this account."
            : "Still Pro is restored on this device.",
        ),
      ).toBeNull();
    });
  }
  it("allows acquisition after conclusive nothing only while access is known none", async () => {
    const props = browser({
      account: { id: "a", confirmed: true },
      restore: { state: "nothing", verified: true, conclusive: true },
    });
    const view = render(PurchaseView, { props });
    expect(
      screen.getByText("No Still Pro purchase was found for this account."),
    ).toBeTruthy();
    await fireEvent.click(buy()!);
    if (props.host === "browser")
      expect(props.checkout.onRequest).toHaveBeenCalledOnce();
    await view.rerender({
      ...props,
      access: { state: "checking", verified: true },
    });
    expect(buy()).toBeNull();
  });
  it("requires verified Restore observations", () => {
    render(PurchaseView, {
      props: browser({
        restore: { state: "nothing", verified: false, conclusive: true },
      }),
    });
    expect(buy()).toBeNull();
    expect(
      screen.queryByText("No Still Pro purchase was found for this account."),
    ).toBeNull();
  });
  it("uses buying-account sign-in intent and then current verified Restore", async () => {
    const props = browser(),
      current = vi.fn();
    const view = render(PurchaseView, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "Restore purchase" }),
    );
    if (props.host === "browser") {
      expect(props.onSignIn).toHaveBeenCalledWith("restore");
      expect(props.restorePort.onRequest).not.toHaveBeenCalled();
    }
    await view.rerender({
      ...props,
      account: { id: "b", confirmed: true },
      restorePort: { verified: true, onRequest: current },
    });
    await fireEvent.click(
      screen.getByRole("button", { name: "Restore purchase" }),
    );
    expect(current).toHaveBeenCalledOnce();
  });
  it("uses current uncertain Restore action and withdraws it when no longer allowed", async () => {
    const old = vi.fn(),
      current = vi.fn(),
      props = browser({
        restore: { state: "failed", verified: true, onAction: old },
      });
    const view = render(PurchaseView, { props });
    await view.rerender({
      ...props,
      restore: { state: "verify", verified: true, onAction: current },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Verify now" }));
    expect(current).toHaveBeenCalledOnce();
    expect(old).not.toHaveBeenCalled();
    await view.rerender({
      ...props,
      restore: { state: "checking", verified: true, onAction: current },
    });
    expect(screen.queryByRole("button", { name: "Verify now" })).toBeNull();
  });
  it("keeps missing actions held and contains no default price, identity or provider", () => {
    render(PurchaseView, {
      props: browser({ onSignIn: undefined, onBack: undefined }),
    });
    expect(buy()!.hasAttribute("disabled")).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Back to settings" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(document.body.textContent).not.toContain("verified fixture");
    expect(document.body.textContent).not.toContain("$9.99");
    expect(document.body.textContent).not.toContain("sam@");
    expect(document.body.textContent).not.toContain("Demonstration");
  });
  it("renders only supplied capability controls in their ordered groups", () => {
    render(PurchaseView, {
      props: browser({
        controls: [{ site: "Facebook", label: "Videos and Watch" }],
      }),
    });
    expect(screen.getByText("Facebook Blocking Options")).toBeTruthy();
    expect(screen.queryByText("YouTube Blocking Options")).toBeNull();
    expect(screen.queryByText("Desktop sidebar ads")).toBeNull();
  });
});

describe("D18 screen layout", () => {
  // The view keeps its own scoped `.ob*` copy (Svelte-scoped specificity, no global leak), so it
  // must stay value-for-value identical to the shared D12 layout sheet it was copied from.
  function rules(css: string) {
    const result = new Map<string, string[]>();
    for (const [, selector, body] of css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/([^{}]+)\{([^{}]*)\}/g))
      result.set(
        selector!.trim().replace(/\s+/g, " "),
        body!
          .split(";")
          .map((declaration) => declaration.trim().replace(/\s+/g, " "))
          .filter(Boolean),
      );
    return result;
  }
  const read = (file: string) =>
    readFileSync(new URL(file, import.meta.url), "utf8");

  it("matches the shared onboarding layout sheet value for value", () => {
    const view = read("./PurchaseView.svelte");
    const scoped = rules(
      view.slice(view.indexOf("<style>") + 7, view.indexOf("</style>")),
    );
    const shared = new Map(
      [...rules(read("./apple-onboarding-layout.css"))].filter(([selector]) =>
        selector.startsWith(".ob"),
      ),
    );
    expect(shared.size).toBeGreaterThan(0);
    expect(scoped).toEqual(shared);
  });
});
