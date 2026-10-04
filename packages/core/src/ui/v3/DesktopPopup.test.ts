import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import {
  DEFAULT_SETTINGS,
  FEATURE_REGISTRY,
  type AccessState,
  type BenefitAccessSnapshot,
  type ServiceId,
  type FeatureId,
} from "@still/shared-types";
import {
  AtomicSettingsWriter,
  requireModernSettings,
} from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import {
  ACCESS_BENEFITS,
  initialAccessSnapshot,
  isBenefitEffective,
  packagedAccessContext,
} from "../../entitlement/access-policy.js";
import DesktopPopup from "./DesktopPopup.svelte";
import type { DesktopPopupProps } from "./presentation.js";

async function fixture(state: AccessState = "free") {
  const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
  const writer = new AtomicSettingsWriter(storage);
  await writer.initialize("never-linked");
  const cache = new SettingsCache({
    get: storage.get.bind(storage),
    set: storage.set.bind(storage),
    subscribe: storage.subscribe.bind(storage),
    commitIntent: writer.commit.bind(writer),
  });
  await cache.hydrate();
  const access = initialAccessSnapshot({
    paidMode: false,
    supported: new Set(ACCESS_BENEFITS),
  });
  const states = { ...access.states };
  for (const row of FEATURE_REGISTRY)
    if (row.tier === "pro") states[row.id] = state;
  const props: DesktopPopupProps = {
    settings: requireModernSettings(cache.currentRecord()),
    access: { ...access, states } satisfies BenefitAccessSnapshot,
    browser: "Chrome",
    privacyUrl: "https://still.test/privacy",
    onGlobalChange: vi.fn(),
    onServiceChange: vi.fn(),
    onFeatureChange: vi.fn(),
    onSignIn: vi.fn(),
    onSettings: vi.fn(),
  };
  return { storage, writer, cache, props };
}

function bindWriter(cache: SettingsCache, props: DesktopPopupProps) {
  let pending: Promise<unknown> = Promise.resolve();
  props.onFeatureChange = vi.fn((id: FeatureId, next: boolean) => {
    pending = cache.setFeature(id, next);
  });
  props.onServiceChange = vi.fn((id: ServiceId, next: boolean) => {
    pending = cache.setService(id, next);
  });
  props.onGlobalChange = vi.fn((next: boolean) => {
    pending = cache.setGlobalOn(next);
  });
  return () => pending;
}

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

  it("presents packaged unsupported choices honestly while free controls commit through the writer", async () => {
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
          expect(within(row).queryByRole("switch")).toBeNull();
          expect(within(row).queryByRole("button")).toBeNull();
          expect(
            within(row).getByText(
              "Not available in this browser. Your choice is saved.",
            ),
          ).toBeTruthy();
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
