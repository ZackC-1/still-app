import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import PopupInvitation from "./PopupInvitation.svelte";
import type { PopupInvitationPresentation } from "./invitation-presentation.js";

export function admitted(
  kind: "rating" | "sync" | "link" = "rating",
): PopupInvitationPresentation {
  const identity = {
    installation: "specimen-install",
    opening: "specimen-opening",
    surface: "chrome",
  };
  return {
    kind,
    identity,
    verified: true,
    fresh: true,
    status: "ready",
    ordinaryOpening: true,
    rating: {
      allowance: { verified: true, fresh: true, global: true, surface: true },
      eligibility: {
        verified: true,
        ageDays: 7,
        distinctUseDays: 3,
        laterOpening: true,
      },
      display: {
        verified: true,
        fresh: true,
        status: "admitted",
        receiptId: "specimen-display",
        identity: { ...identity },
      },
    },
    accept: {
      verified: true,
      status: "ready",
      identity: { ...identity },
      request: vi.fn(),
    },
    dismiss: {
      verified: true,
      status: "ready",
      identity: { ...identity },
      request: vi.fn(),
    },
  };
}

describe("controlled popup invitation", () => {
  it.each([
    [
      "rating",
      "Rate Still",
      "A rating helps other people find Still.",
      "Rate Still",
    ],
    [
      "sync",
      "Use the same settings in every browser",
      "Sign in for free settings sync. Optional.",
      "Sign in",
    ],
    [
      "link",
      "Link Still Pro to an account",
      "So you can restore it in other browsers. Optional.",
      "Link",
    ],
  ] as const)(
    "renders only exact %s copy and keeps the current card until caller confirmation",
    async (kind, title, body, action) => {
      const presentation = admitted(kind);
      const view = render(PopupInvitation, { presentation });
      expect(screen.getByRole("region", { name: title })).toBeTruthy();
      expect(screen.getByText(body)).toBeTruthy();
      await fireEvent.click(screen.getByRole("button", { name: action }));
      expect(presentation.accept!.request).toHaveBeenCalledOnce();
      expect(presentation.dismiss!.request).not.toHaveBeenCalled();
      await fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      expect(presentation.dismiss!.request).not.toHaveBeenCalled();
      expect(screen.getByText(body)).toBeTruthy();
      await view.rerender({
        presentation: { ...presentation, status: "consumed" },
      });
      expect(screen.queryByText(body)).toBeNull();
    },
  );

  it.each([
    "unverified",
    "stale",
    "pending",
    "consumed",
    "unknown",
    "early",
    "allowance-off",
    "allowance-unknown",
    "allowance-stale",
    "young",
    "few-days",
    "eligibility-unknown",
    "not-later",
    "missing-display",
    "pending-display",
    "consumed-display",
    "stale-display",
    "unverified-display",
    "wrong-display",
    "empty-display",
    "empty-install",
    "empty-opening",
    "empty-surface",
    "safari",
    "suppressed",
  ])("does not display or issue intents for %s authority", (reason) => {
    const p = admitted();
    switch (reason) {
      case "unverified":
        p.verified = false;
        break;
      case "stale":
        p.fresh = false;
        break;
      case "pending":
      case "consumed":
      case "unknown":
        p.status = reason;
        break;
      case "early":
        p.ordinaryOpening = false;
        break;
      case "allowance-off":
        p.rating!.allowance.global = false;
        break;
      case "allowance-unknown":
        p.rating!.allowance.verified = false;
        break;
      case "allowance-stale":
        p.rating!.allowance.fresh = false;
        break;
      case "young":
        p.rating!.eligibility.ageDays = 6;
        break;
      case "few-days":
        p.rating!.eligibility.distinctUseDays = 2;
        break;
      case "eligibility-unknown":
        p.rating!.eligibility.verified = false;
        break;
      case "not-later":
        p.rating!.eligibility.laterOpening = false;
        break;
      case "missing-display":
        p.rating = undefined;
        break;
      case "pending-display":
        p.rating!.display.status = "pending";
        break;
      case "consumed-display":
        p.rating!.display.status = "consumed";
        break;
      case "stale-display":
        p.rating!.display.fresh = false;
        break;
      case "unverified-display":
        p.rating!.display.verified = false;
        break;
      case "wrong-display":
        p.rating!.display.identity.opening = "other";
        break;
      case "empty-display":
        p.rating!.display.receiptId = " ";
        break;
      case "empty-install":
        p.identity.installation = " ";
        break;
      case "empty-opening":
        p.identity.opening = " ";
        break;
      case "empty-surface":
        p.identity.surface = " ";
        break;
      case "safari":
        p.identity.surface = "safari";
        break;
      case "suppressed":
        p.suppressed = "consent";
        break;
    }
    render(PopupInvitation, { presentation: p });
    expect(screen.queryByRole("region")).toBeNull();
    expect(p.accept!.request).not.toHaveBeenCalled();
    expect(p.dismiss!.request).not.toHaveBeenCalled();
  });

  it.each(["accept", "dismiss"] as const)(
    "holds missing, pending, unverified and foreign %s ports at the actual click",
    async (which) => {
      const p = admitted();
      const request = p[which]!.request;
      const view = render(PopupInvitation, { presentation: p });
      const name = which === "accept" ? "Rate Still" : "Not now";
      for (const port of [
        undefined,
        { ...p[which]!, verified: false },
        { ...p[which]!, status: "pending" as const },
        { ...p[which]!, identity: { ...p.identity, opening: "other" } },
      ]) {
        await view.rerender({ presentation: { ...p, [which]: port } });
        const control = screen.getByRole("button", { name });
        expect(control).toHaveAttribute("aria-disabled", "true");
        await fireEvent.click(control);
        expect(request).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["installation", "opening", "surface"] as const)(
    "cannot forward a queued event across a changed %s",
    async (field) => {
      const p = admitted();
      const view = render(PopupInvitation, { presentation: p });
      const old = screen.getByRole("button", { name: "Rate Still" });
      const next = admitted();
      next.identity[field] = "replacement";
      await view.rerender({ presentation: next });
      await fireEvent.click(old);
      expect(p.accept!.request).not.toHaveBeenCalled();
      expect(next.accept!.request).not.toHaveBeenCalled();
    },
  );

  it("uses only current replacement ports and cannot act on detached or unmounted controls", async () => {
    const p = admitted();
    const view = render(PopupInvitation, { presentation: p });
    const old = screen.getByRole("button", { name: "Rate Still" });
    const next = admitted();
    await view.rerender({ presentation: next });
    await fireEvent.click(old);
    expect(p.accept!.request).not.toHaveBeenCalled();
    expect(next.accept!.request).not.toHaveBeenCalled();
    const current = screen.getByRole("button", { name: "Rate Still" });
    await fireEvent.click(current);
    expect(next.accept!.request).toHaveBeenCalledOnce();
    view.unmount();
    await fireEvent.click(current);
    expect(next.accept!.request).toHaveBeenCalledOnce();
  });
});

describe("current invitation request fence", () => {
  it.each(["accept", "dismiss"] as const)(
    "dispatches only the first %s choice before caller status publication",
    async (first) => {
      const p = admitted();
      const view = render(PopupInvitation, { presentation: p });
      const chosen = screen.getByRole("button", {
        name: first === "accept" ? "Rate Still" : "Not now",
      });
      await fireEvent.click(chosen);
      await fireEvent.click(chosen);
      await fireEvent.click(
        screen.getByRole("button", {
          name: first === "accept" ? "Not now" : "Rate Still",
        }),
      );
      expect(p[first]!.request).toHaveBeenCalledOnce();
      expect(
        p[first === "accept" ? "dismiss" : "accept"]!.request,
      ).not.toHaveBeenCalled();
      expect(screen.getByRole("region", { name: "Rate Still" })).toBeTruthy();
      await view.rerender({ presentation: { ...p, status: "pending" } });
      expect(screen.queryByRole("region", { name: "Rate Still" })).toBeNull();
      const next = admitted();
      await view.rerender({ presentation: next });
      await fireEvent.click(screen.getByRole("button", { name: "Rate Still" }));
      expect(next.accept!.request).toHaveBeenCalledOnce();
    },
  );
  it("fences a reentrant current request before calling the port", async () => {
    const p = admitted();
    let entered = false;
    p.accept!.request = vi.fn(() => {
      if (!entered) {
        entered = true;
        screen.getByRole("button", { name: "Rate Still" }).click();
      }
    });
    render(PopupInvitation, { presentation: p });
    await fireEvent.click(screen.getByRole("button", { name: "Rate Still" }));
    expect(p.accept!.request).toHaveBeenCalledOnce();
    expect(screen.getByRole("region", { name: "Rate Still" })).toBeTruthy();
  });
  it("allows a fresh verified replacement port without replaying an old queued intent", async () => {
    const p = admitted();
    const view = render(PopupInvitation, { presentation: p });
    const old = screen.getByRole("button", { name: "Rate Still" });
    await fireEvent.click(old);
    expect(p.accept!.request).toHaveBeenCalledOnce();
    const replacement = { ...p.accept!, request: vi.fn() };
    const next = { ...p, accept: replacement };
    await view.rerender({ presentation: next });
    await fireEvent.click(old);
    expect(replacement.request).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Rate Still" }));
    expect(replacement.request).toHaveBeenCalledOnce();
  });
});
