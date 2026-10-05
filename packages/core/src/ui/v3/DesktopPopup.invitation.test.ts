import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import { requireModernSettings } from "../../storage/atomic-settings.js";
import DesktopPopup from "./DesktopPopup.svelte";
import { fixture, bindWriter } from "./DesktopPopup.fixtures.js";

function invitationSpecimen(
  kind: "rating" | "sync" | "link" = "rating",
  surface = "chrome",
): import("./invitation-presentation.js").PopupInvitationPresentation {
  const identity = {
    installation: "specimen-install",
    opening: "specimen-opening",
    surface,
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
        receiptId: "specimen-admission",
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

describe("optional D28 desktop invitation", () => {
  it("keeps default popup DOM and real writer choices while rendering only one current selected invitation", async () => {
    const { props, storage, cache } = await fixture();
    const settled = bindWriter(cache, props);
    const saved = await storage.get();
    const view = render(DesktopPopup, { props });
    expect(screen.queryByRole("region", { name: "Rate Still" })).toBeNull();
    const headings = Array.from(
      document.querySelectorAll("h2"),
      (h) => h.textContent,
    );
    props.invitation = invitationSpecimen();
    await view.rerender(props);
    const card = screen.getByRole("region", { name: "Rate Still" });
    expect(card.previousElementSibling?.classList.contains("site-scroll")).toBe(
      true,
    );
    expect(card.nextElementSibling?.textContent).toContain("Settings sync");
    await fireEvent.click(screen.getByRole("button", { name: "Rate Still" }));
    expect(props.invitation.accept!.request).toHaveBeenCalledOnce();
    expect(await storage.get()).toEqual(saved);
    props.invitation = invitationSpecimen("sync");
    await view.rerender(props);
    expect(screen.queryByRole("region", { name: "Rate Still" })).toBeNull();
    expect(
      screen.getByRole("region", {
        name: "Use the same settings in every browser",
      }),
    ).toBeTruthy();
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    await fireEvent.click(screen.getByRole("switch", { name: "Shorts" }));
    await settled();
    expect(
      requireModernSettings((await storage.get())!).sites["youtube.shorts"],
    ).toBe(false);
    props.invitation = undefined;
    await view.rerender(props);
    expect(
      Array.from(document.querySelectorAll("h2"), (h) => h.textContent),
    ).toEqual(headings);
    expect(document.querySelectorAll(".service-options.open")).toHaveLength(1);
  });

  it.each(["pending", "failed", "caution"] as const)(
    "suppresses invitation during known %s sync state without rewriting settings",
    async (tone) => {
      const { props, storage } = await fixture();
      const saved = await storage.get();
      props.invitation = invitationSpecimen();
      props.account = {
        address: "specimen@still.test",
        status: { tone, text: "Current sync observation" },
      };
      render(DesktopPopup, { props });
      expect(screen.queryByRole("region", { name: "Rate Still" })).toBeNull();
      expect(await storage.get()).toEqual(saved);
    },
  );

  it("holds desktop setup until a current verified port and suppresses invitations", async () => {
    const { props, storage } = await fixture();
    const saved = await storage.get();
    props.invitation = invitationSpecimen();
    props.desktopSetup = {
      title: "Still can't block on these websites yet.",
      detail: "Allow Still on these websites so it can block there.",
      actionLabel: "Allow",
    };
    const view = render(DesktopPopup, { props });
    const held = screen.getByRole("button", { name: "Allow" });
    expect(held).toHaveAttribute("aria-disabled", "true");
    await fireEvent.click(held);
    expect(screen.queryByRole("region", { name: "Rate Still" })).toBeNull();
    const port = invitationSpecimen().accept!;
    props.desktopSetup = { ...props.desktopSetup, action: port };
    await view.rerender(props);
    await fireEvent.click(held);
    expect(port.request).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(port.request).toHaveBeenCalledOnce();
    props.desktopSetup = {
      ...props.desktopSetup,
      action: { ...port, verified: false },
    };
    await view.rerender(props);
    await fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(port.request).toHaveBeenCalledOnce();
    expect(await storage.get()).toEqual(saved);
  });

  it("does not transplant a Chrome receipt into a Firefox popup", async () => {
    const { props } = await fixture();
    props.browser = "Firefox";
    props.invitation = invitationSpecimen();
    render(DesktopPopup, { props });
    expect(screen.queryByRole("region", { name: "Rate Still" })).toBeNull();
  });
});

describe("issued invitation across actual host sync suppression", () => {
  it.each(["accept", "dismiss"] as const)(
    "retains the %s claim through pending sync and identical restoration",
    async (first) => {
      const { props, storage } = await fixture();

      const p = invitationSpecimen("rating", "chrome");
      props.invitation = p;
      const saved = await storage.get();
      const view = render(DesktopPopup, { props });
      const name = (choice: "accept" | "dismiss") =>
        choice === "accept" ? "Rate Still" : "Not now";
      const opposite = first === "accept" ? "dismiss" : "accept";
      await fireEvent.click(screen.getByRole("button", { name: name(first) }));
      expect(p[first]!.request).toHaveBeenCalledOnce();
      props.account = {
        address: "specimen@still.test",
        status: { tone: "pending", text: "Current sync pending" },
      };
      await view.rerender(props);
      expect(screen.queryByRole("region", { name: "Rate Still" })).toBeNull();
      props.account = undefined;
      await view.rerender(props);
      expect(props.invitation).toBe(p);
      await fireEvent.click(screen.getByRole("button", { name: name(first) }));
      await fireEvent.click(
        screen.getByRole("button", { name: name(opposite) }),
      );
      expect(p[first]!.request).toHaveBeenCalledOnce();
      expect(p[opposite]!.request).not.toHaveBeenCalled();
      expect(screen.getByRole("region", { name: "Rate Still" })).toBeTruthy();
      expect(await storage.get()).toEqual(saved);
      expect(props.onGlobalChange).not.toHaveBeenCalled();
      expect(props.onServiceChange).not.toHaveBeenCalled();
      expect(props.onFeatureChange).not.toHaveBeenCalled();
    },
  );
});

describe("issued desktop setup request", () => {
  it.each(["duplicate", "reentrant"] as const)(
    "claims the verified Allow request before %s delivery",
    async (schedule) => {
      const { props, storage } = await fixture();
      const port = invitationSpecimen().accept!;
      let entered = false;
      port.request = vi.fn(() => {
        if (schedule === "reentrant" && !entered) {
          entered = true;
          screen.getByRole("button", { name: "Allow" }).click();
        }
      });
      props.desktopSetup = {
        title: "Still can't block on these websites yet.",
        detail: "Allow Still on these websites so it can block there.",
        actionLabel: "Allow",
        action: port,
      };
      const saved = await storage.get();
      const view = render(DesktopPopup, { props });
      const old = screen.getByRole("button", { name: "Allow" });
      await fireEvent.click(old);
      if (schedule === "duplicate") await fireEvent.click(old);
      expect(port.request).toHaveBeenCalledOnce();
      expect(old).toHaveAttribute("aria-disabled", "true");
      props.desktopSetup = { ...props.desktopSetup, action: { ...port } };
      await view.rerender(props);
      await fireEvent.click(screen.getByRole("button", { name: "Allow" }));
      expect(port.request).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Allow" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      const fresh = { ...port, request: vi.fn() };
      props.desktopSetup = { ...props.desktopSetup, action: fresh };
      await view.rerender(props);
      await fireEvent.click(old);
      expect(fresh.request).not.toHaveBeenCalled();
      const current = screen.getByRole("button", { name: "Allow" });
      expect(current).not.toHaveAttribute("aria-disabled", "true");
      await fireEvent.click(current);
      expect(fresh.request).toHaveBeenCalledOnce();
      expect(await storage.get()).toEqual(saved);
      expect(props.onGlobalChange).not.toHaveBeenCalled();
      expect(props.onServiceChange).not.toHaveBeenCalled();
      expect(props.onFeatureChange).not.toHaveBeenCalled();
      view.unmount();
      await fireEvent.click(current);
      expect(fresh.request).toHaveBeenCalledOnce();
    },
  );
});

describe("per-issued invitation claims through DesktopPopup", () => {
  const title = (kind: "rating" | "sync" | "link") =>
    ({
      rating: "Rate Still",
      sync: "Use the same settings in every browser",
      link: "Link Still Pro to an account",
    })[kind];
  const control = (
    kind: "rating" | "sync" | "link",
    choice: "accept" | "dismiss",
  ) =>
    within(screen.getByRole("region", { name: title(kind) })).getByRole(
      "button",
      {
        name:
          choice === "dismiss"
            ? "Not now"
            : { rating: "Rate Still", sync: "Sign in", link: "Link" }[kind],
      },
    );
  it.each(
    (["rating", "sync", "link"] as const).flatMap((kind) =>
      (["accept", "dismiss"] as const).flatMap((first) =>
        (["missing", "unready"] as const).map(
          (unavailable) => [kind, first, unavailable] as const,
        ),
      ),
    ),
  )(
    "holds %s %s when chosen host port is %s",
    async (kind, first, unavailable) => {
      const { props, storage } = await fixture();

      const a = invitationSpecimen(kind, "chrome");
      const opposite = first === "accept" ? "dismiss" : "accept";
      const saved = await storage.get();
      props.invitation = a;
      const view = render(DesktopPopup, { props });
      await fireEvent.click(control(kind, first));
      expect(a[first]!.request).toHaveBeenCalledOnce();
      props.invitation = {
        ...a,
        [first]:
          unavailable === "missing"
            ? undefined
            : { ...a[first]!, verified: false, request: vi.fn() },
      };
      await view.rerender(props);
      await fireEvent.click(control(kind, opposite));
      expect(a[opposite]!.request).not.toHaveBeenCalled();
      props.invitation = a;
      await view.rerender(props);
      await fireEvent.click(control(kind, first));
      await fireEvent.click(control(kind, opposite));
      expect(a[first]!.request).toHaveBeenCalledOnce();
      expect(a[opposite]!.request).not.toHaveBeenCalled();
      expect(await storage.get()).toEqual(saved);
      expect(props.onGlobalChange).not.toHaveBeenCalled();
      expect(props.onServiceChange).not.toHaveBeenCalled();
      expect(props.onFeatureChange).not.toHaveBeenCalled();
    },
  );
  it.each(
    (["rating", "sync", "link"] as const).flatMap((kind) =>
      (["accept", "dismiss"] as const).map((first) => [kind, first] as const),
    ),
  )(
    "holds restored %s %s A after issuing B through the host",
    async (kind, first) => {
      const { props, storage } = await fixture();

      const a = invitationSpecimen(kind, "chrome");
      const b = invitationSpecimen(kind, "chrome");
      const opposite = first === "accept" ? "dismiss" : "accept";
      const saved = await storage.get();
      props.invitation = a;
      const view = render(DesktopPopup, { props });
      await fireEvent.click(control(kind, first));
      expect(a[first]!.request).toHaveBeenCalledOnce();
      props.invitation = b;
      await view.rerender(props);
      await fireEvent.click(control(kind, first));
      expect(b[first]!.request).toHaveBeenCalledOnce();
      props.invitation = a;
      await view.rerender(props);
      await fireEvent.click(control(kind, first));
      expect(a[first]!.request).toHaveBeenCalledOnce();
      await fireEvent.click(control(kind, opposite));
      expect(a[opposite]!.request).not.toHaveBeenCalled();
      expect(await storage.get()).toEqual(saved);
      expect(props.onGlobalChange).not.toHaveBeenCalled();
      expect(props.onServiceChange).not.toHaveBeenCalled();
      expect(props.onFeatureChange).not.toHaveBeenCalled();
    },
  );
});

describe("retained per-issued desktop setup claims", () => {
  it("holds setup A after issuing B and restoring the same callback and copied identity", async () => {
    const { props } = await fixture();
    const a = invitationSpecimen().accept!;
    const b = { ...a, request: vi.fn() };
    const setup = {
      title: "Setup",
      detail: "Allow websites",
      actionLabel: "Allow",
      action: a,
    };
    props.desktopSetup = setup;
    const view = render(DesktopPopup, { props });
    const old = screen.getByRole("button", { name: "Allow" });
    await fireEvent.click(old);
    expect(a.request).toHaveBeenCalledOnce();
    props.desktopSetup = { ...setup, action: b };
    await view.rerender(props);
    await fireEvent.click(old);
    expect(b.request).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(b.request).toHaveBeenCalledOnce();
    props.desktopSetup = {
      ...setup,
      action: { ...a, identity: { ...a.identity } },
    };
    await view.rerender(props);
    await fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(a.request).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Allow" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  it.each(["installation", "opening"] as const)(
    "renews setup %s with the same callback once and holds equivalent republication",
    async (field) => {
      const { props } = await fixture();
      const a = invitationSpecimen().accept!;
      const setup = {
        title: "Setup",
        detail: "Allow websites",
        actionLabel: "Allow",
        action: a,
      };
      props.desktopSetup = setup;
      const view = render(DesktopPopup, { props });
      const old = screen.getByRole("button", { name: "Allow" });
      await fireEvent.click(old);
      expect(a.request).toHaveBeenCalledOnce();
      const next = { ...a, identity: { ...a.identity, [field]: "renewed" } };
      expect(next.request).toBe(a.request);
      props.desktopSetup = { ...setup, action: next };
      await view.rerender(props);
      await fireEvent.click(old);
      expect(a.request).toHaveBeenCalledOnce();
      const current = screen.getByRole("button", { name: "Allow" });
      await fireEvent.click(current);
      await fireEvent.click(current);
      expect(a.request).toHaveBeenCalledTimes(2);
      props.desktopSetup = {
        ...setup,
        action: { ...next, identity: { ...next.identity } },
      };
      await view.rerender(props);
      await fireEvent.click(screen.getByRole("button", { name: "Allow" }));
      expect(a.request).toHaveBeenCalledTimes(2);
    },
  );
});
