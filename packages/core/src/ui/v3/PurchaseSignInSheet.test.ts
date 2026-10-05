import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PurchaseSignInSheet from "./PurchaseSignInSheet.svelte";
import type {
  PurchaseSignInOperation,
  PurchaseSignInSheetProps,
} from "./purchase-signin-presentation.js";

afterEach(cleanup);
const operation: PurchaseSignInOperation = {
  requestId: "request-a",
  ownerId: "owner-a",
  purpose: "purchase",
};
function props(
  overrides: Partial<PurchaseSignInSheetProps> = {},
): PurchaseSignInSheetProps {
  return {
    open: true,
    operation,
    email: "",
    code: "",
    observation: { operation, verified: true, state: "email" },
    emailInput: { operation, verified: true, onRequest: vi.fn() },
    codeInput: { operation, verified: true, onRequest: vi.fn() },
    send: { operation, verified: true, onRequest: vi.fn() },
    verify: { operation, verified: true, onRequest: vi.fn() },
    dismiss: { operation, verified: true, onRequest: vi.fn() },
    background: {
      host: "browser",
      controls: [],
      access: { state: "none", verified: true },
      channel: "ready",
      offer: { verified: true, price: "fixture only" },
      purchase: { state: "idle" },
      checkout: { verified: true, onRequest: vi.fn() },
      restorePort: { verified: true, onRequest: vi.fn() },
      onSignIn: vi.fn(),
      onBack: vi.fn(),
    },
    ...overrides,
  };
}
const dialog = () => screen.getByRole("dialog");
const form = () => dialog().querySelector("form")!;
describe("controlled purchase sign-in modal", () => {
  it("has exact purchase title, associated copy, labelled email and real initial focus", () => {
    render(PurchaseSignInSheet, { props: props() });
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(dialog().getAttribute("aria-labelledby")).toBe(
      screen.getByRole("heading", { name: "Sign in to get Still Pro" }).id,
    );
    expect(
      document.getElementById(dialog().getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe(
      "Your purchase is saved to your Still account, so you can restore it in other browsers.",
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Email address"));
    expect(
      (screen.getByLabelText("Email address") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy();
    expect(
      within(dialog())
        .getByRole("button", { name: "Send code" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
  it("uses the distinct restore title and buying-account instruction", () => {
    render(PurchaseSignInSheet, {
      props: props({ operation: { ...operation, purpose: "restore" } }),
    });
    expect(
      screen.getByRole("heading", { name: "Sign in to restore Still Pro" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Use the account you bought Still Pro with."),
    ).toBeTruthy();
  });
  it("forwards email input intent while leaving value and step caller-controlled", async () => {
    const p = props();
    render(PurchaseSignInSheet, { props: p });
    await fireEvent.input(screen.getByLabelText("Email address"), {
      target: { value: "person@example.test" },
    });
    expect(p.emailInput?.onRequest).toHaveBeenCalledWith({
      operation,
      value: "person@example.test",
    });
    expect(
      (screen.getByLabelText("Email address") as HTMLInputElement).value,
    ).toBe("");
    expect(p.send?.onRequest).not.toHaveBeenCalled();
  });
  for (const email of ["", "invalid-address"]) {
    it("does not send an empty or invalid current email through form submission", async () => {
      const p = props({ email });
      render(PurchaseSignInSheet, { props: p });
      await fireEvent.submit(form());
      expect(p.send?.onRequest).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("6-digit code")).toBeNull();
    });
  }
  it("sends current email without locally claiming code delivery or confirmation", async () => {
    const p = props({ email: "person@example.test" });
    render(PurchaseSignInSheet, { props: p });
    await fireEvent.submit(form());
    expect(p.send?.onRequest).toHaveBeenCalledWith({
      operation,
      value: p.email,
    });
    expect(screen.queryByLabelText("6-digit code")).toBeNull();
    expect(p.verify?.onRequest).not.toHaveBeenCalled();
  });
  it("uses the current replacement callback and current controlled value", async () => {
    const p = props({ email: "old@example.test" }),
      current = vi.fn();
    const view = render(PurchaseSignInSheet, { props: p });
    await view.rerender({
      ...p,
      email: "new@example.test",
      send: { operation, verified: true, onRequest: current },
    });
    await fireEvent.submit(form());
    expect(current).toHaveBeenCalledWith({
      operation,
      value: "new@example.test",
    });
    expect(p.send?.onRequest).not.toHaveBeenCalled();
  });
  for (const state of ["sending", "verifying"] as const) {
    it(`holds repeated form and input effects during ${state}`, async () => {
      const p = props({
        email: "person@example.test",
        code: "123456",
        observation: { operation, verified: true, state },
      });
      render(PurchaseSignInSheet, { props: p });
      await fireEvent.submit(form());
      await fireEvent.submit(form());
      await fireEvent.input(dialog().querySelector("input")!, {
        target: { value: "654321" },
      });
      expect(p.send?.onRequest).not.toHaveBeenCalled();
      expect(p.verify?.onRequest).not.toHaveBeenCalled();
      expect(p.emailInput?.onRequest).not.toHaveBeenCalled();
      expect(p.codeInput?.onRequest).not.toHaveBeenCalled();
    });
  }
  for (const change of [
    { operation: { ...operation, requestId: "new" } },
    { operation: { ...operation, ownerId: "new" } },
    { operation: { ...operation, purpose: "restore" as const } },
    { operation: { ...operation, requestId: " " } },
    { observation: { operation, verified: false, state: "email" as const } },
  ]) {
    it("holds stale or unverified observations and cannot submit old work", async () => {
      const p = props({ email: "person@example.test" });
      const view = render(PurchaseSignInSheet, { props: p });
      const originalForm = form();
      await view.rerender({ ...p, ...change });
      await fireEvent.submit(originalForm);
      expect(dialog().querySelector("form")).toBeNull();
      expect(p.send?.onRequest).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("Email address")).toBeNull();
    });
  }
  for (const send of [
    undefined,
    { operation, verified: false, onRequest: vi.fn() },
    {
      operation: { ...operation, ownerId: "other" },
      verified: true,
      onRequest: vi.fn(),
    },
  ]) {
    it("holds absent, unverified or differently owned send ports at final effect boundary", async () => {
      const p = props({ email: "person@example.test", send });
      render(PurchaseSignInSheet, { props: p });
      await fireEvent.submit(form());
      if (send) expect(send.onRequest).not.toHaveBeenCalled();
      else
        expect(
          within(dialog())
            .getByRole("button", { name: "Send code" })
            .hasAttribute("disabled"),
        ).toBe(true);
    });
  }
  it("normalizes code input only as a current controlled intent", async () => {
    const p = props({
      observation: { operation, verified: true, state: "code" },
    });
    render(PurchaseSignInSheet, { props: p });
    await fireEvent.input(screen.getByLabelText("6-digit code"), {
      target: { value: "a1234567" },
    });
    expect(p.codeInput?.onRequest).toHaveBeenCalledWith({
      operation,
      value: "123456",
    });
    expect(
      (screen.getByLabelText("6-digit code") as HTMLInputElement).value,
    ).toBe("");
    expect(p.verify?.onRequest).not.toHaveBeenCalled();
  });
  it("six digits can request verification but cannot authenticate or close locally", async () => {
    const p = props({
      code: "123456",
      observation: { operation, verified: true, state: "code" },
    });
    render(PurchaseSignInSheet, { props: p });
    await fireEvent.submit(form());
    expect(p.verify?.onRequest).toHaveBeenCalledWith({
      operation,
      value: "123456",
    });
    expect(p.send?.onRequest).not.toHaveBeenCalled();
    expect(p.dismiss?.onRequest).not.toHaveBeenCalled();
    expect(dialog()).toBeTruthy();
    expect(screen.getByLabelText("6-digit code")).toBeTruthy();
  });
  it("shows supplied failure text and retries only the actual code stage", async () => {
    const p = props({
      code: "123456",
      observation: {
        operation,
        verified: true,
        state: "failed",
        field: "code",
        text: "Verified fixture failure",
      },
    });
    render(PurchaseSignInSheet, { props: p });
    await fireEvent.submit(form());
    expect(screen.getByRole("status").textContent).toBe(
      "Verified fixture failure",
    );
    expect(p.verify?.onRequest).toHaveBeenCalledOnce();
    expect(p.send?.onRequest).not.toHaveBeenCalled();
  });
  for (const account of [
    undefined,
    { id: "a", confirmed: false },
    { id: " ", confirmed: true },
  ]) {
    it("does not show a confirmation from an unconfirmed or empty account", () => {
      render(PurchaseSignInSheet, {
        props: props({
          observation: {
            operation,
            verified: true,
            state: "confirmed",
            account,
            text: "Verified fixture confirmation",
          },
        }),
      });
      expect(screen.queryByText("Verified fixture confirmation")).toBeNull();
    });
  }
  it("shows only supplied current confirmed-account status and performs no follow-on action", () => {
    const p = props({
      observation: {
        operation,
        verified: true,
        state: "confirmed",
        account: { id: "a", confirmed: true },
        text: "Verified fixture confirmation",
      },
    });
    render(PurchaseSignInSheet, { props: p });
    expect(screen.getByRole("status").textContent).toBe(
      "Verified fixture confirmation",
    );
    expect(p.dismiss?.onRequest).not.toHaveBeenCalled();
    expect(p.background.checkout.onRequest).not.toHaveBeenCalled();
  });
  it("dismisses by current Cancel, Escape and scrim ports without fake closing", async () => {
    const p = props(),
      current = vi.fn(),
      view = render(PurchaseSignInSheet, { props: p });
    await view.rerender({
      ...p,
      dismiss: { operation, verified: true, onRequest: current },
    });
    await fireEvent.click(
      within(dialog()).getByRole("button", { name: "Cancel" }),
    );
    await fireEvent.keyDown(window, { key: "Escape" });
    await fireEvent.click(document.querySelector(".scrim")!);
    expect(current).toHaveBeenCalledTimes(3);
    expect(p.dismiss?.onRequest).not.toHaveBeenCalled();
    expect(dialog()).toBeTruthy();
  });
  it("keeps missing dismissal focusable for pending containment without firing or fake closing", async () => {
    const p = props({
      dismiss: undefined,
      observation: { operation, verified: true, state: "sending" },
    });
    render(PurchaseSignInSheet, { props: p });
    const cancel = within(dialog()).getByRole("button", { name: "Cancel" });
    expect(cancel.hasAttribute("disabled")).toBe(false);
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    document.body.focus();
    await fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    await fireEvent.click(cancel);
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(dialog()).toBeTruthy();
  });
  it("traps Tab both directions and recovers after a focused input becomes disabled", async () => {
    const p = props({ email: "person@example.test" }),
      view = render(PurchaseSignInSheet, { props: p });
    const email = screen.getByLabelText("Email address"),
      cancel = within(dialog()).getByRole("button", { name: "Cancel" });
    cancel.focus();
    await fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(email);
    await fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    email.focus();
    await view.rerender({
      ...p,
      observation: { operation, verified: true, state: "sending" },
    });
    document.body.setAttribute("tabindex", "-1");
    document.body.focus();
    await fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    document.body.removeAttribute("tabindex");
  });
  it("makes background inert and strips every supplied background callback", async () => {
    const p = props();
    render(PurchaseSignInSheet, { props: p });
    const bg = document.querySelector('div[aria-hidden="true"]') as HTMLElement;
    expect(bg.inert).toBe(true);
    for (const button of bg.querySelectorAll("button"))
      await fireEvent.click(button);
    expect(p.background.onBack).not.toHaveBeenCalled();
    expect(p.background.onSignIn).not.toHaveBeenCalled();
    expect(p.background.checkout.onRequest).not.toHaveBeenCalled();
    expect(p.background.restorePort.onRequest).not.toHaveBeenCalled();
  });
  it("restores opener on actual close and removes Escape listener after close and unmount", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const p = props(),
      view = render(PurchaseSignInSheet, { props: p });
    await view.rerender({ ...p, open: false });
    expect(document.activeElement).toBe(opener);
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(p.dismiss?.onRequest).not.toHaveBeenCalled();
    expect(document.querySelector('div[aria-hidden="true"]')).toBeNull();
    opener.focus();
    await view.rerender(p);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(p.dismiss?.onRequest).not.toHaveBeenCalled();
    opener.remove();
  });
});

import PurchaseView from "./PurchaseView.svelte";

describe("reviewed sign-in input and background regressions", () => {
  for (const raw of ["123456", "123 456", "123-456"]) {
    it(`allows the complete ${raw} input before normalization`, async () => {
      const p = props({ observation: { operation, verified: true, state: "code" } });
      const view = render(PurchaseSignInSheet, { props: p });
      const input = screen.getByLabelText("6-digit code") as HTMLInputElement;
      expect(input.hasAttribute("maxlength")).toBe(false);
      await fireEvent.input(input, { target: { value: raw } });
      expect(p.codeInput?.onRequest).toHaveBeenCalledExactlyOnceWith({ operation, value: "123456" });
      // The caller accepts this intent; neither input nor submit authenticates locally.
      await view.rerender({ ...p, code: "123456" });
      await fireEvent.submit(form());
      expect(p.verify?.onRequest).toHaveBeenCalledExactlyOnceWith({ operation, value: "123456" });
      expect(dialog()).toBeTruthy();
      expect(p.dismiss?.onRequest).not.toHaveBeenCalled();
    });
  }
  for (const code of ["", "12345", "1234567", "12345a"]) {
    it(`does not verify invalid controlled code ${JSON.stringify(code)}`, async () => {
      const p = props({ code, observation: { operation, verified: true, state: "code" } });
      render(PurchaseSignInSheet, { props: p });
      await fireEvent.submit(form());
      expect(p.verify?.onRequest).not.toHaveBeenCalled();
    });
  }
  it("strips checkout and restore callbacks proven reachable for the same confirmed account", async () => {
    const p = props();
    p.background.account = { id: "fixture-account-a", confirmed: true };
    const positive = render(PurchaseView, { props: p.background });
    await fireEvent.click(screen.getByRole("button", { name: "Get Still Pro" }));
    await fireEvent.click(screen.getByRole("button", { name: "Restore purchase" }));
    expect(p.background.checkout.onRequest).toHaveBeenCalledOnce();
    expect(p.background.restorePort.onRequest).toHaveBeenCalledOnce();
    expect(p.background.onSignIn).not.toHaveBeenCalled();
    positive.unmount();
    vi.mocked(p.background.checkout.onRequest!).mockClear();
    vi.mocked(p.background.restorePort.onRequest!).mockClear();
    render(PurchaseSignInSheet, { props: p });
    const background = document.querySelector('div[aria-hidden="true"]') as HTMLElement;
    expect(background.inert).toBe(true);
    // Synthetic events bypass inert, so explicit callback removal must also hold.
    for (const button of background.querySelectorAll("button")) await fireEvent.click(button);
    expect(p.background.checkout.onRequest).not.toHaveBeenCalled();
    expect(p.background.restorePort.onRequest).not.toHaveBeenCalled();
    expect(p.background.onSignIn).not.toHaveBeenCalled();
    expect(p.background.onBack).not.toHaveBeenCalled();
  });
  for (const [state, label] of [["failed", "Try again"], ["verify", "Verify now"]] as const) {
    it(`strips the ${label} callback proven reachable for the same verified restore state`, async () => {
      const p = props();
      p.background.account = { id: "fixture-account-a", confirmed: true };
      const onAction = vi.fn();
      p.background.restore = { state, verified: true, onAction };
      const positive = render(PurchaseView, { props: p.background });
      await fireEvent.click(screen.getByRole("button", { name: label }));
      expect(onAction).toHaveBeenCalledOnce();
      positive.unmount();
      onAction.mockClear();
      render(PurchaseSignInSheet, { props: p });
      const background = document.querySelector('div[aria-hidden="true"]') as HTMLElement;
      expect(background.inert).toBe(true);
      for (const button of background.querySelectorAll("button")) await fireEvent.click(button);
      expect(onAction).not.toHaveBeenCalled();
      expect(p.background.checkout.onRequest).not.toHaveBeenCalled();
      expect(p.background.restorePort.onRequest).not.toHaveBeenCalled();
      expect(p.background.onSignIn).not.toHaveBeenCalled();
    });
  }
});
