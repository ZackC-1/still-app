import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import TikTokBlocked from "./TikTokBlocked.svelte";
import ConfirmationDialog from "./ConfirmationDialog.svelte";
import type {
  TikTokBlockedPresentation,
  TikTokActionPort,
} from "./tiktok-blocked-presentation.js";

// Hypothetical caller bindings for presentation tests; no native allowance proof.
function fixture(
  state: TikTokBlockedPresentation["state"] = "blocked",
): TikTokBlockedPresentation {
  const identity = {
    request: "fixture-request",
    tab: "fixture-tab",
    document: "fixture-document",
  };
  const binding = {
    identity,
    observation: "fixture-observation",
    verified: true,
    fresh: true,
  };
  const port = (): TikTokActionPort => ({
    ...binding,
    identity: { ...identity },
    status: "ready",
    request: vi.fn(),
  });
  return {
    ...binding,
    host: "browser",
    state,
    capability: { ...binding, identity: { ...identity }, status: "supported" },
    requestConfirmation: port(),
    confirmOpen: port(),
    cancel: port(),
    settings: port(),
    reload: port(),
    outcome:
      state === "reload"
        ? {
            ...binding,
            identity: { ...identity },
            status: "granted-reload-needed",
            destinationValidated: true,
          }
        : undefined,
  };
}

function openControl() {
  return screen.getByRole("button", { name: "Open TikTok this time" });
}
function confirmControl() {
  return within(screen.getByRole("dialog")).getByRole("button", {
    name: "Open TikTok this time",
  });
}

describe("controlled TikTok closed page", () => {
  it("keeps free closed content visible without caller authority and denies opening", async () => {
    render(TikTokBlocked);
    expect(
      screen.getByRole("heading", { name: "TikTok stays closed." }),
    ).toBeVisible();
    const open = screen.getByRole("button", { name: "Open TikTok this time" });
    expect(open).toHaveAttribute("aria-disabled", "true");
    await fireEvent.click(open);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Reload this page to open TikTok.")).toBeNull();
  });
});

describe("caller observation and intent authority", () => {
  it("requests confirmation only, keeps the page closed and opens only on caller observation", async () => {
    const p = fixture();
    const view = render(TikTokBlocked, { presentation: p });
    openControl().focus();
    await fireEvent.click(openControl());
    expect(p.requestConfirmation!.request).toHaveBeenCalledOnce();
    expect(p.confirmOpen!.request).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    const next = { ...p, state: "confirmation" as const };
    await view.rerender({ presentation: next });
    expect(
      screen.getByRole("dialog", { name: "Open TikTok in this tab?" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "TikTok opens in this tab until you close it. Other tabs stay closed, and your setting doesn't change.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Keep it closed" }),
    ).toHaveFocus();
    expect(confirmControl()).toHaveClass("primary");
    await fireEvent.click(confirmControl());
    expect(p.confirmOpen!.request).toHaveBeenCalledOnce();
    expect(p.cancel!.request).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.queryByText("Reload this page to open TikTok.")).toBeNull();
  });

  it.each(["request", "tab", "document"] as const)(
    "denies empty %s and foreign capability identity",
    async (field) => {
      const p = fixture();
      p.identity[field] = " ";
      const view = render(TikTokBlocked, { presentation: p });
      await fireEvent.click(openControl());
      expect(p.requestConfirmation!.request).not.toHaveBeenCalled();
      const next = fixture();
      next.capability!.identity[field] = "foreign";
      await view.rerender({ presentation: next });
      await fireEvent.click(openControl());
      expect(next.requestConfirmation!.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    "missing",
    "unknown",
    "unavailable",
    "unverified",
    "stale",
    "foreign-observation",
    "pending",
    "empty-observation",
    "unverified-observation",
    "stale-observation",
  ])(
    "holds %s capability/observation without hiding free content",
    async (kind) => {
      const p = fixture();
      if (kind === "missing") p.capability = undefined;
      if (kind === "unknown" || kind === "unavailable")
        p.capability!.status = kind;
      if (kind === "unverified") p.capability!.verified = false;
      if (kind === "stale") p.capability!.fresh = false;
      if (kind === "foreign-observation") p.capability!.observation = "foreign";
      if (kind === "pending") p.state = "pending";
      if (kind === "empty-observation") p.observation = " ";
      if (kind === "unverified-observation") p.verified = false;
      if (kind === "stale-observation") p.fresh = false;
      const view = render(TikTokBlocked, { presentation: p });
      expect(openControl()).toHaveAttribute("aria-disabled", "true");
      await fireEvent.click(openControl());
      expect(p.requestConfirmation!.request).not.toHaveBeenCalled();
      expect(
        screen.getByRole("heading", { name: "TikTok stays closed." }),
      ).toBeVisible();
      await view.rerender({ presentation: { ...p, state: "confirmation" } });
      if (kind !== "pending") expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it.each([
    "requestConfirmation",
    "confirmOpen",
    "cancel",
    "settings",
    "reload",
  ] as const)(
    "holds missing, pending, unknown, unavailable, unverified, stale and foreign %s ports",
    async (action) => {
      for (const kind of [
        "missing",
        "pending",
        "unknown",
        "unavailable",
        "unverified",
        "stale",
        "foreign-request",
        "foreign-tab",
        "foreign-document",
        "foreign-observation",
        "missing-callback",
      ]) {
        const p = fixture(
          action === "confirmOpen" || action === "cancel"
            ? "confirmation"
            : action === "reload"
              ? "reload"
              : "blocked",
        );
        const port = p[action]!;
        const request = port.request;
        if (kind === "missing") p[action] = undefined;
        else if (
          kind === "pending" ||
          kind === "unknown" ||
          kind === "unavailable"
        )
          port.status = kind;
        else if (kind === "unverified") port.verified = false;
        else if (kind === "stale") port.fresh = false;
        else if (kind === "foreign-observation") port.observation = "foreign";
        else if (kind === "missing-callback") port.request = undefined;
        else
          port.identity[
            kind.replace("foreign-", "") as "request" | "tab" | "document"
          ] = "foreign";
        const view = render(TikTokBlocked, { presentation: p });
        const control =
          action === "confirmOpen"
            ? confirmControl()
            : action === "cancel"
              ? screen.getByRole("button", { name: "Keep it closed" })
              : action === "settings"
                ? screen.getByRole("button", {
                    name: "Change this in Still settings",
                  })
                : action === "reload"
                  ? screen.getByRole("button", { name: "Reload page" })
                  : openControl();
        await fireEvent.click(control);
        expect(request, action + ":" + kind).not.toHaveBeenCalled();
        if (action === "confirmOpen" || action === "cancel")
          expect(screen.getByRole("dialog")).toBeVisible();
        view.unmount();
      }
    },
  );

  it("uses independently supplied browser settings and exact iOS manual copy without a settings action", async () => {
    const p = fixture();
    p.capability = undefined;
    const view = render(TikTokBlocked, { presentation: p });
    await fireEvent.click(
      screen.getByRole("button", { name: "Change this in Still settings" }),
    );
    expect(p.settings!.request).toHaveBeenCalledOnce();
    expect(p.requestConfirmation!.request).not.toHaveBeenCalled();
    await view.rerender({ presentation: { ...p, host: "ios" } });
    expect(
      screen.getByText(
        "To change this, open the Still app and turn off TikTok website.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Change this in Still settings" }),
    ).toBeNull();
    expect(p.settings!.request).toHaveBeenCalledOnce();
  });

  it.each(["request", "tab", "document", "observation", "port", "callback"])(
    "denies detached queued opening after %s replacement and unmount",
    async (kind) => {
      const p = fixture();
      const view = render(TikTokBlocked, { presentation: p });
      const old = openControl();
      const next = fixture();
      if (kind === "observation") next.observation = "replacement";
      else if (kind !== "port" && kind !== "callback")
        next.identity[kind as "request" | "tab" | "document"] = "replacement";
      await view.rerender({ presentation: next });
      await fireEvent.click(old);
      expect(p.requestConfirmation!.request).not.toHaveBeenCalled();
      expect(next.requestConfirmation!.request).not.toHaveBeenCalled();
      const current = openControl();
      view.unmount();
      await fireEvent.click(current);
      expect(next.requestConfirmation!.request).not.toHaveBeenCalled();
    },
  );

  it.each(["confirmation", "reload"] as const)(
    "denies old %s effect after observation or port replacement and unmount",
    async (state) => {
      const p = fixture(state);
      const view = render(TikTokBlocked, { presentation: p });
      const old =
        state === "confirmation"
          ? confirmControl()
          : screen.getByRole("button", { name: "Reload page" });
      const next = fixture(state);
      await view.rerender({ presentation: next });
      await fireEvent.click(old);
      const action = state === "confirmation" ? "confirmOpen" : "reload";
      expect(p[action]!.request).not.toHaveBeenCalled();
      expect(next[action]!.request).not.toHaveBeenCalled();
      const current =
        state === "confirmation"
          ? confirmControl()
          : screen.getByRole("button", { name: "Reload page" });
      view.unmount();
      await fireEvent.click(current);
      expect(next[action]!.request).not.toHaveBeenCalled();
    },
  );

  it.each(["cancel", "settings"] as const)(
    "denies detached %s effects after replacement and unmount",
    async (action) => {
      const p = fixture(action === "cancel" ? "confirmation" : "blocked");
      const view = render(TikTokBlocked, { presentation: p });
      const control = () =>
        screen.getByRole("button", {
          name:
            action === "cancel"
              ? "Keep it closed"
              : "Change this in Still settings",
        });
      const old = control();
      const next = fixture(p.state);
      await view.rerender({ presentation: next });
      await fireEvent.click(old);
      expect(p[action]!.request).not.toHaveBeenCalled();
      expect(next[action]!.request).not.toHaveBeenCalled();
      const current = control();
      view.unmount();
      await fireEvent.click(current);
      expect(next[action]!.request).not.toHaveBeenCalled();
    },
  );

  it("rechecks capability and identity at the final handler even before a caller rerender", async () => {
    const p = fixture();
    const view = render(TikTokBlocked, { presentation: p });
    const control = openControl();
    p.capability!.fresh = false;
    await fireEvent.click(control);
    expect(p.requestConfirmation!.request).not.toHaveBeenCalled();
    p.capability!.fresh = true;
    p.identity.document = "replacement";
    await fireEvent.click(control);
    expect(p.requestConfirmation!.request).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe("current choice fence and cancellation", () => {
  it.each(["blocked", "confirmation", "reload"] as const)(
    "fences duplicate and reentrant %s effects before callback entry, without optimistic result",
    async (state) => {
      const p = fixture(state);
      const action =
        state === "blocked"
          ? "requestConfirmation"
          : state === "confirmation"
            ? "confirmOpen"
            : "reload";
      let entered = false;
      const control = () =>
        state === "blocked"
          ? openControl()
          : state === "confirmation"
            ? confirmControl()
            : screen.getByRole("button", { name: "Reload page" });
      p[action]!.request = vi.fn(() => {
        if (!entered) {
          entered = true;
          control().click();
        }
      });
      render(TikTokBlocked, { presentation: p });
      await fireEvent.click(control());
      await fireEvent.click(control());
      expect(p[action]!.request).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("heading", { name: "TikTok stays closed." }),
      ).toBeVisible();
    },
  );

  it("lets a current cancellation follow a pending confirm request, but never permits a grant after cancel", async () => {
    const p = fixture("confirmation");
    const view = render(TikTokBlocked, { presentation: p });
    await fireEvent.click(confirmControl());
    await fireEvent.click(
      screen.getByRole("button", { name: "Keep it closed" }),
    );
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(p.cancel!.request).toHaveBeenCalledOnce();
    expect(p.confirmOpen!.request).toHaveBeenCalledOnce();
    const next = fixture("confirmation");
    await view.rerender({ presentation: next });
    await fireEvent.click(
      screen.getByRole("button", { name: "Keep it closed" }),
    );
    await fireEvent.click(confirmControl());
    expect(next.cancel!.request).toHaveBeenCalledOnce();
    expect(next.confirmOpen!.request).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("recovers only on a caller pending/fresh transition or replacement port", async () => {
    const p = fixture();
    const view = render(TikTokBlocked, { presentation: p });
    const old = openControl();
    await fireEvent.click(old);
    await view.rerender({ presentation: p });
    await fireEvent.click(openControl());
    expect(p.requestConfirmation!.request).toHaveBeenCalledOnce();
    await view.rerender({ presentation: { ...p, state: "pending" } });
    await fireEvent.click(openControl());
    expect(p.requestConfirmation!.request).toHaveBeenCalledOnce();
    const fresh = fixture();
    await view.rerender({ presentation: fresh });
    await fireEvent.click(openControl());
    expect(fresh.requestConfirmation!.request).toHaveBeenCalledOnce();
    const replacement = { ...fresh.requestConfirmation!, request: vi.fn() };
    const detached = openControl();
    await view.rerender({
      presentation: { ...fresh, requestConfirmation: replacement },
    });
    await fireEvent.click(detached);
    expect(replacement.request).not.toHaveBeenCalled();
    await fireEvent.click(openControl());
    expect(replacement.request).toHaveBeenCalledOnce();
  });

  it.each(["button", "Escape", "scrim"])(
    "cancels through %s only on current authority; caller close restores opener",
    async (method) => {
      const p = fixture();
      const view = render(TikTokBlocked, { presentation: p });
      const opener = openControl();
      opener.focus();
      await fireEvent.click(opener);
      await view.rerender({ presentation: { ...p, state: "confirmation" } });
      const cancel = screen.getByRole("button", { name: "Keep it closed" });
      expect(cancel).toHaveFocus();
      await fireEvent.keyDown(window, { key: "Tab" });
      expect(confirmControl()).toHaveFocus();
      await fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
      expect(cancel).toHaveFocus();
      if (method === "button") await fireEvent.click(cancel);
      if (method === "Escape")
        await fireEvent.keyDown(window, { key: "Escape" });
      if (method === "scrim")
        await fireEvent.click(document.querySelector(".scrim")!);
      expect(p.cancel!.request).toHaveBeenCalledOnce();
      expect(p.confirmOpen!.request).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeVisible();
      await view.rerender({ presentation: p });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(opener).toHaveFocus();
    },
  );

  it("makes the background inert and removes every background callback while confirmation is open", async () => {
    const p = fixture("confirmation");
    render(TikTokBlocked, { presentation: p });
    await fireEvent.keyDown(window, { key: "Tab" });
    const background =
      document.querySelector<HTMLDivElement>(".blocked-actions")!;
    expect(background.inert).toBe(true);
    for (const button of background.querySelectorAll("button"))
      await fireEvent.click(button);
    expect(p.requestConfirmation!.request).not.toHaveBeenCalled();
    expect(p.settings!.request).not.toHaveBeenCalled();
    expect(p.confirmOpen!.request).not.toHaveBeenCalled();
  });
});

describe("caller-confirmed reload outcome", () => {
  it.each([
    "missing",
    "unverified",
    "stale",
    "foreign-request",
    "foreign-tab",
    "foreign-document",
    "foreign-observation",
    "unvalidated",
  ])("withholds reload copy/action for %s outcome", async (kind) => {
    const p = fixture("reload");
    if (kind === "missing") p.outcome = undefined;
    else if (kind === "unverified") p.outcome!.verified = false;
    else if (kind === "stale") p.outcome!.fresh = false;
    else if (kind === "foreign-observation") p.outcome!.observation = "foreign";
    else if (kind === "unvalidated") p.outcome!.destinationValidated = false;
    else
      p.outcome!.identity[
        kind.replace("foreign-", "") as "request" | "tab" | "document"
      ] = "foreign";
    render(TikTokBlocked, { presentation: p });
    expect(screen.queryByRole("button", { name: "Reload page" })).toBeNull();
    expect(screen.queryByText("Reload this page to open TikTok.")).toBeNull();
    await fireEvent.click(openControl());
    expect(p.reload!.request).not.toHaveBeenCalled();
    expect(p.requestConfirmation!.request).not.toHaveBeenCalled();
  });
  it("shows exact reload content only from verified outcome and does not auto-reload", async () => {
    const p = fixture("confirmation");
    p.confirmOpen!.request = vi.fn(() => Promise.resolve());
    const view = render(TikTokBlocked, { presentation: p });
    await fireEvent.click(confirmControl());
    await Promise.resolve();
    expect(screen.queryByText("Reload this page to open TikTok.")).toBeNull();
    const next = fixture("reload");
    await view.rerender({ presentation: next });
    expect(screen.getByText("Reload this page to open TikTok.")).toBeVisible();
    expect(next.reload!.request).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
    expect(next.reload!.request).toHaveBeenCalledOnce();
    expect(screen.getByText("Reload this page to open TikTok.")).toBeVisible();
  });
});

describe("maintained dialog defaults", () => {
  it("retains danger-solid, Cancel, safe initial focus and existing callback API", async () => {
    const confirm = vi.fn(),
      cancel = vi.fn();
    render(ConfirmationDialog, {
      open: true,
      title: "Existing destructive dialog",
      confirmLabel: "Delete",
      onConfirm: confirm,
      onCancel: cancel,
    });
    const button = screen.getByRole("button", { name: "Delete" });
    expect(button).toHaveClass("danger-solid");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await fireEvent.click(button);
    expect(confirm).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
  });
});
