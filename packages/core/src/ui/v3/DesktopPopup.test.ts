import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import { FEATURE_REGISTRY, type ServiceId } from "@still/shared-types";
import { requireModernSettings } from "../../storage/atomic-settings.js";
import {
  initialAccessSnapshot,
  isBenefitEffective,
  packagedAccessContext,
} from "../../entitlement/access-policy.js";
import DesktopPopup from "./DesktopPopup.svelte";
import { fixture, bindWriter } from "./DesktopPopup.fixtures.js";

describe("controlled D01 presentation", () => {
  it("mounts feature controls only in the one open section and preserves saved choices on close", async () => {
    const { props } = await fixture("purchased");
    const saved = structuredClone(props.settings);
    const { container } = render(DesktopPopup, { props });
    expect(container.querySelectorAll('button[role="switch"]')).toHaveLength(5);
    const youtube = screen.getByRole("button", { name: "YouTube Blocker" });
    await fireEvent.click(youtube);
    expect(screen.getByRole("switch", { name: "Shorts" })).toBeVisible();
    expect(
      container.querySelectorAll("#site-instagram-panel button"),
    ).toHaveLength(0);
    await fireEvent.click(
      screen.getByRole("button", { name: "Instagram Blocker" }),
    );
    expect(
      container.querySelectorAll("#site-youtube-panel button"),
    ).toHaveLength(0);
    await fireEvent.click(
      screen.getByRole("button", { name: "Instagram Blocker" }),
    );
    expect(container.querySelectorAll('button[role="switch"]')).toHaveLength(5);
    expect(props.settings).toEqual(saved);
    expect(props.onFeatureChange).not.toHaveBeenCalled();
  });

  it("holds already rendered controls and delivered click events without changing choices or blocking expanders/settings", async () => {
    const { props } = await fixture();
    const view = render(DesktopPopup, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    const global = screen.getByRole("switch", { name: "Still" });
    const service = screen.getByRole("switch", { name: "Still on YouTube" });
    const shorts = screen.getByRole("switch", { name: "Shorts" });
    const delivered = [global, service, shorts].map(
      (element) => () =>
        element.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    props.commandsDisabled = true;
    await view.rerender(props);
    for (const element of [global, service, shorts]) {
      expect(element).toHaveAttribute("aria-disabled", "true");
      expect(element).toHaveAttribute("aria-checked", "true");
    }
    for (const click of delivered) click();
    expect(props.onGlobalChange).not.toHaveBeenCalled();
    expect(props.onServiceChange).not.toHaveBeenCalled();
    expect(props.onFeatureChange).not.toHaveBeenCalled();
    await fireEvent.click(
      screen.getByRole("button", { name: "Instagram Blocker" }),
    );
    expect(
      screen.getByRole("button", { name: "Instagram Blocker" }),
    ).toHaveAttribute("aria-expanded", "true");
    await fireEvent.click(
      screen.getByRole("button", { name: /Settings. Find Still in Chrome/ }),
    );
    expect(props.onSettings).toHaveBeenCalledOnce();
  });

  it("uses account presence independently of its optional display address", async () => {
    const { props } = await fixture();
    props.account = {
      status: { tone: "pending", text: "Checking settings sync" },
    };
    render(DesktopPopup, { props });
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(
      screen.queryByText(
        "Free. Keep your settings updated across every supported surface.",
      ),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking settings sync",
    );
    expect(props.onSignIn).not.toHaveBeenCalled();
  });

  it("presents packaged dormant Still Pro rows locked and inert (decision 24) while free controls commit through the writer", async () => {
    const { storage, cache, props } = await fixture();
    await cache.setFeature("youtube.comments", true);
    props.settings = requireModernSettings(cache.currentRecord());
    const context = packagedAccessContext();
    const access = initialAccessSnapshot();
    expect(access).toEqual(initialAccessSnapshot(context));
    for (const row of FEATURE_REGISTRY) {
      expect(context.supported.has(row.id)).toBe(row.tier === "free");
      expect(access.states[row.id]).toBe(
        row.tier === "free" ? "free" : "unsupported",
      );
    }
    expect(context.supported.has("tiktok.all")).toBe(true);
    expect(access.states["tiktok.all"]).toBe("free");
    props.access = access;
    props.onPurchase = vi.fn();
    const settled = bindWriter(cache, props);
    const saved = await storage.get();
    const view = render(DesktopPopup, { props });

    for (const service of ["youtube", "instagram", "facebook"] as const) {
      const title = {
        youtube: "YouTube Blocker",
        instagram: "Instagram Blocker",
        facebook: "Facebook Blocker",
      }[service];
      await fireEvent.click(screen.getByRole("button", { name: title }));
      const panel = screen.getByRole("group", { name: title });
      for (const feature of FEATURE_REGISTRY.filter(
        (row) => row.service === service,
      )) {
        const label =
          feature.tier === "free"
            ? service === "youtube"
              ? "Shorts"
              : "Reels"
            : feature.name;
        const row = within(panel)
          .getByText(label)
          .closest(".option-row") as HTMLElement;
        if (feature.tier === "pro") {
          // Owner decision 24: paid off shows the existing locked design, never the unsupported
          // note, and the lock offers nothing even though a purchase port is supplied.
          expect(within(row).queryByRole("switch")).toBeNull();
          expect(within(row).queryByText(/Not available/)).toBeNull();
          expect(row).toHaveAttribute("data-access", "locked");
          expect(within(row).getByText("Still Pro")).toBeTruthy();
          const lock = within(row).getByRole("button", {
            name: `${label}. Included in Still Pro. See Still Pro`,
          });
          expect(lock).toHaveAttribute("aria-disabled", "true");
          await fireEvent.click(lock);
        } else {
          const control = within(row).getByRole("switch", { name: label });
          expect(control).not.toHaveAttribute("aria-disabled", "true");
          expect(control).toHaveAttribute("aria-checked", "true");
        }
      }
      expect(
        screen.queryByRole("button", { name: "Purchase Still Pro" }),
      ).toBeNull();
    }
    expect(await storage.get()).toEqual(saved);
    expect(props.onFeatureChange).not.toHaveBeenCalled();
    expect(props.onPurchase).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "TikTok Blocker" })).toBeNull();
    const tiktok = screen.getByRole("switch", { name: "TikTok website" });
    expect(tiktok).not.toHaveAttribute("aria-disabled", "true");
    await fireEvent.click(tiktok);
    expect(tiktok).toHaveAttribute("aria-checked", "true");
    await settled();
    expect(requireModernSettings((await storage.get())!).services.tiktok).toBe(
      false,
    );
    props.settings = requireModernSettings(cache.currentRecord());
    await view.rerender(props);
    expect(tiktok).toHaveAttribute("aria-checked", "false");

    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    const shorts = screen.getByRole("switch", { name: "Shorts" });
    await fireEvent.click(shorts);
    expect(shorts).toHaveAttribute("aria-checked", "true");
    await settled();
    const committed = await storage.get();
    expect(committed!.atomic!.sequence).toBe(saved!.atomic!.sequence + 2);
    expect(requireModernSettings(committed!).sites["youtube.shorts"]).toBe(
      false,
    );
    expect(requireModernSettings(committed!).sites["youtube.comments"]).toBe(
      true,
    );
    expect(props.onFeatureChange).toHaveBeenCalledExactlyOnceWith(
      "youtube.shorts",
      false,
    );
    expect(props.onServiceChange).toHaveBeenCalledExactlyOnceWith(
      "tiktok",
      false,
    );
    expect(props.onGlobalChange).not.toHaveBeenCalled();
    expect(props.onPurchase).not.toHaveBeenCalled();
    props.settings = requireModernSettings(cache.currentRecord());
    await view.rerender(props);
    expect(shorts).toHaveAttribute("aria-checked", "false");
    view.unmount();
  });

  it("preserves a saved choice across mounted access transitions without issuing settings intents", async () => {
    const { storage, cache, props } = await fixture("purchased");
    await cache.setFeature("youtube.comments", true);
    props.settings = requireModernSettings(cache.currentRecord());
    const settled = bindWriter(cache, props);
    const saved = await storage.get();
    const cached = cache.currentRecord();
    const view = render(DesktopPopup, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );

    for (const state of [
      "purchased",
      "checking",
      "verification_required",
      "protected",
      "unsupported",
      "locked",
      "purchased",
    ] as const) {
      props.access = {
        ...props.access,
        states: { ...props.access.states, "youtube.comments": state },
      };
      await view.rerender(props);
      const row = screen
        .getByText("Comments")
        .closest(".option-row") as HTMLElement;
      const usable = state === "purchased" || state === "protected";
      if (state === "unsupported" || state === "locked") {
        expect(within(row).queryByRole("switch")).toBeNull();
        if (state === "unsupported") {
          expect(
            within(row).getByText(
              "Not available in this browser. Your choice is saved.",
            ),
          ).toBeTruthy();
        } else {
          const locked = within(row).getByRole("button", {
            name: "Comments. Included in Still Pro. See Still Pro",
          });
          expect(locked).toHaveAttribute("aria-disabled", "true");
          await fireEvent.click(locked);
        }
      } else {
        const comments = within(row).getByRole("switch", { name: "Comments" });
        expect(comments).toHaveAttribute("aria-checked", "true");
        if (usable) {
          expect(comments).not.toHaveAttribute("aria-disabled", "true");
        } else {
          expect(comments).toHaveAttribute("aria-disabled", "true");
          expect(comments).toHaveAccessibleDescription(/Your choice is saved/);
          await fireEvent.click(comments);
        }
      }
      await settled();
      expect(props.onFeatureChange).not.toHaveBeenCalled();
      expect(props.onServiceChange).not.toHaveBeenCalled();
      expect(props.onGlobalChange).not.toHaveBeenCalled();
      expect(await storage.get()).toEqual(saved);
      expect(cache.currentRecord()).toEqual(cached);
    }

    const comments = screen.getByRole("switch", { name: "Comments" });
    await fireEvent.click(comments);
    expect(comments).toHaveAttribute("aria-checked", "true");
    await settled();
    expect(props.onFeatureChange).toHaveBeenCalledExactlyOnceWith(
      "youtube.comments",
      false,
    );
    expect(
      requireModernSettings((await storage.get())!).sites["youtube.comments"],
    ).toBe(false);
    expect((await storage.get())!.atomic!.sequence).toBe(
      saved!.atomic!.sequence + 1,
    );
    props.settings = requireModernSettings(cache.currentRecord());
    await view.rerender(props);
    expect(comments).toHaveAttribute("aria-checked", "false");
    view.unmount();
  });

  it("keeps free Shorts usable through uncertain optional access and waits for committed props", async () => {
    const { storage, cache, props } = await fixture("checking");
    await cache.setFeature("youtube.comments", true);
    props.settings = requireModernSettings(cache.currentRecord());
    const settled = bindWriter(cache, props);
    const view = render(DesktopPopup, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );

    for (const [state, next] of [
      ["checking", false],
      ["verification_required", true],
    ] as const) {
      props.access = {
        ...props.access,
        states: { ...props.access.states, "youtube.comments": state },
      };
      const before = await storage.get();
      await view.rerender(props);
      expect(await storage.get()).toEqual(before);
      const shorts = screen.getByRole("switch", { name: "Shorts" });
      expect(shorts).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("switch", { name: "Comments" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await fireEvent.click(shorts);
      expect(shorts).toHaveAttribute("aria-checked", String(!next));
      await settled();
      const committed = await storage.get();
      expect(committed!.atomic!.sequence).toBe(before!.atomic!.sequence + 1);
      expect(requireModernSettings(committed!).sites["youtube.shorts"]).toBe(
        next,
      );
      expect(requireModernSettings(committed!).sites["youtube.comments"]).toBe(
        true,
      );
      expect(shorts).toHaveAttribute("aria-checked", String(!next));
      props.settings = requireModernSettings(cache.currentRecord());
      await view.rerender(props);
      expect(shorts).toHaveAttribute("aria-checked", String(next));
    }
    expect(props.onFeatureChange).toHaveBeenCalledTimes(2);
    expect(props.onServiceChange).not.toHaveBeenCalled();
    expect(props.onGlobalChange).not.toHaveBeenCalled();
    view.unmount();
  });

  it("restores a non-null section and its outgoing change on remount without writing settings or memory on restoration", async () => {
    const { storage, cache, props } = await fixture();
    const settled = bindWriter(cache, props);
    let remembered: ServiceId | null = "youtube";
    const read = vi.fn(() => remembered);
    const write = vi.fn((service: ServiceId | null) => {
      remembered = service;
    });
    props.sectionMemory = { read, write };
    props.features = ["youtube.shorts", "instagram.reels"];
    const saved = await storage.get();
    const view = render(DesktopPopup, { props });
    expect(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("Comments")).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: "Instagram Blocker" }),
    );
    expect(write.mock.calls).toEqual([["instagram"]]);
    expect(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    ).toHaveAttribute("aria-expanded", "false");
    view.unmount();
    expect(write.mock.calls).toEqual([["instagram"]]);
    const restored = render(DesktopPopup, { props });
    expect(read).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("button", { name: "Instagram Blocker" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelectorAll(".service-options.open")).toHaveLength(1);
    expect(write.mock.calls).toEqual([["instagram"]]);
    await settled();
    expect(await storage.get()).toEqual(saved);
    expect(props.onFeatureChange).not.toHaveBeenCalled();
    expect(props.onServiceChange).not.toHaveBeenCalled();
    expect(props.onGlobalChange).not.toHaveBeenCalled();
    restored.unmount();
  });

  it.each(["youtube", "tiktok"] as const)(
    "does not invent a fallback for remembered %s when it has no rendered section",
    async (rememberedService) => {
      const { storage, cache, props } = await fixture();
      const settled = bindWriter(cache, props);
      let remembered: ServiceId | null = rememberedService;
      const write = vi.fn((service: ServiceId | null) => {
        remembered = service;
      });
      props.sectionMemory = { read: () => remembered, write };
      props.services = ["instagram", "tiktok"];
      const saved = await storage.get();
      const view = render(DesktopPopup, { props });
      expect(
        screen.queryByRole("button", { name: "YouTube Blocker" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "TikTok Blocker" }),
      ).toBeNull();
      expect(
        screen.getByRole("switch", { name: "TikTok website" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Instagram Blocker" }),
      ).toHaveAttribute("aria-expanded", "false");
      expect(document.querySelectorAll(".service-options.open")).toHaveLength(
        0,
      );
      expect(write).not.toHaveBeenCalled();
      await fireEvent.click(
        screen.getByRole("button", { name: "Instagram Blocker" }),
      );
      view.unmount();
      const restored = render(DesktopPopup, { props });
      expect(
        screen.getByRole("button", { name: "Instagram Blocker" }),
      ).toHaveAttribute("aria-expanded", "true");
      expect(write.mock.calls).toEqual([["instagram"]]);
      await settled();
      expect(await storage.get()).toEqual(saved);
      expect(props.onFeatureChange).not.toHaveBeenCalled();
      expect(props.onServiceChange).not.toHaveBeenCalled();
      expect(props.onGlobalChange).not.toHaveBeenCalled();
      restored.unmount();
    },
  );

  it("persists actual feature/master/global intents through the maintained writer and retains choices while Off", async () => {
    const { storage, cache, props } = await fixture();
    let pending: Promise<unknown> = Promise.resolve();
    props.onFeatureChange = (id, next) => {
      pending = cache.setFeature(id, next);
    };
    props.onServiceChange = (id, next) => {
      pending = cache.setService(id, next);
    };
    props.onGlobalChange = (next) => {
      pending = cache.setGlobalOn(next);
    };
    const view = render(DesktopPopup, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    const comments = screen.getByRole("switch", { name: "Comments" });
    await fireEvent.click(comments);
    expect(comments).toHaveAttribute("aria-checked", "false"); // no optimistic state
    await pending;
    const read = async () => {
      props.settings = requireModernSettings(cache.currentRecord());
      await view.rerender(props);
    };
    await read();
    expect(comments).toHaveAttribute("aria-checked", "true");
    expect(
      requireModernSettings((await storage.get())!).sites["youtube.comments"],
    ).toBe(true);
    await fireEvent.click(
      screen.getByRole("switch", { name: "Still on YouTube" }),
    );
    await pending;
    await read();
    expect(comments).toHaveAttribute("aria-disabled", "true");
    expect(comments).toHaveAttribute("aria-checked", "true");
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await pending;
    await read();
    const saved = requireModernSettings((await storage.get())!);
    expect(saved.globalOn).toBe(false);
    expect(saved.sites["youtube.comments"]).toBe(true);
    expect(isBenefitEffective(saved, "youtube.comments", "free")).toBe(false);
    const sequence = (await storage.get())!.atomic!.sequence;
    await fireEvent.click(comments);
    await pending;
    expect((await storage.get())!.atomic!.sequence).toBe(sequence);
    view.unmount();
  });

  it.each(["checking", "verification_required"] as const)(
    "keeps saved On visible but ignores %s input and purchase",
    async (state) => {
      const { cache, props } = await fixture(state);
      await cache.setFeature("youtube.comments", true);
      props.settings = requireModernSettings(cache.currentRecord());
      props.onPurchase = vi.fn();
      render(DesktopPopup, { props });
      await fireEvent.click(
        screen.getByRole("button", { name: "YouTube Blocker" }),
      );
      const comments = screen.getByRole("switch", { name: "Comments" });
      expect(comments).toHaveAttribute("aria-checked", "true");
      expect(comments).toHaveAttribute("aria-disabled", "true");
      expect(comments).toHaveAccessibleDescription(/Your choice is saved/);
      comments.focus();
      expect(comments).toHaveFocus();
      await fireEvent.click(comments);
      expect(props.onFeatureChange).not.toHaveBeenCalled();
      expect(screen.queryByText("Purchase Still Pro")).toBeNull();
      expect(props.onPurchase).not.toHaveBeenCalled();
      await fireEvent.click(screen.getByRole("switch", { name: "Shorts" }));
      expect(props.onFeatureChange).toHaveBeenCalledWith(
        "youtube.shorts",
        false,
      );
    },
  );

  it("has one locally remembered section, closes it on repeat and tears down without settings writes", async () => {
    const { props } = await fixture();
    const write = vi.fn();
    props.sectionMemory = { read: () => null, write };
    const view = render(DesktopPopup, { props });
    const youtube = screen.getByRole("button", { name: "YouTube Blocker" });
    const instagram = screen.getByRole("button", { name: "Instagram Blocker" });
    expect(youtube).toHaveAttribute("aria-expanded", "false");
    await fireEvent.click(youtube);
    await fireEvent.click(instagram);
    expect(youtube).toHaveAttribute("aria-expanded", "false");
    expect(instagram).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelectorAll(".service-options.open")).toHaveLength(1);
    await fireEvent.click(instagram);
    expect(write.mock.calls).toEqual([["youtube"], ["instagram"], [null]]);
    expect(props.onFeatureChange).not.toHaveBeenCalled();
    expect(props.onGlobalChange).not.toHaveBeenCalled();
    view.unmount();
    expect(document.querySelector(".still-ui")).toBeNull();
  });

  it("does not fabricate unsupported access or purchase eligibility and routes real account actions", async () => {
    const { cache, props } = await fixture("locked");
    await cache.setFeature("youtube.autoplay", true);
    props.settings = requireModernSettings(cache.currentRecord());
    props.access = {
      ...props.access,
      states: { ...props.access.states, "youtube.autoplay": "unsupported" },
    };
    const retry = vi.fn();
    props.account = {
      address: "owner@still.test",
      status: { tone: "failed", text: "The current sync failed.", retry },
    };
    render(DesktopPopup, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    const row = screen.getByText("Autoplay prevention").closest(".option-row")!;
    expect(within(row as HTMLElement).queryByRole("switch")).toBeNull();
    expect(
      within(row as HTMLElement).getByText(
        "Not available in this browser. Your choice is saved.",
      ),
    ).toBeTruthy();
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Comments. Included in Still Pro. See Still Pro",
      }),
    );
    expect(props.onFeatureChange).not.toHaveBeenCalled();
    expect(screen.queryByText("Purchase Still Pro")).toBeNull();
    expect(screen.getByText("owner@still.test")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: /Settings\. Find Still/ }),
    );
    expect(props.onSettings).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("link", { name: "Privacy policy" }),
    ).toHaveAttribute("href", props.privacyUrl);
    expect(
      requireModernSettings(cache.currentRecord()).sites["youtube.autoplay"],
    ).toBe(true);
  });
  it("offers only a trusted eligible purchase and removes it when current access becomes uncertain", async () => {
    const { props } = await fixture("locked");
    const buy = vi.fn();
    props.onPurchase = buy;
    const view = render(DesktopPopup, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "Purchase Still Pro" }),
    );
    expect(buy).toHaveBeenCalledOnce();
    props.access = {
      ...props.access,
      states: { ...props.access.states, "youtube.comments": "checking" },
    };
    await view.rerender(props);
    expect(screen.queryByText("Purchase Still Pro")).toBeNull();
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Related videos. Included in Still Pro. See Still Pro",
      }),
    );
    expect(buy).toHaveBeenCalledOnce();
  });
});
