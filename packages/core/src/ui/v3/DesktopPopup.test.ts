import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import {
  DEFAULT_SETTINGS,
  FEATURE_REGISTRY,
  type AccessState,
  type BenefitAccessSnapshot,
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

describe("controlled D01 presentation", () => {
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
