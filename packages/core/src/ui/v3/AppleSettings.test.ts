import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import {
  DEFAULT_SETTINGS,
  FEATURE_REGISTRY,
  type AccessState,
  type FeatureId,
  type ServiceId,
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
} from "../../entitlement/access-policy.js";
import AppleSettings from "./AppleSettings.svelte";
import SyncCard from "./SyncCard.svelte";
import type { AppleSettingsProps } from "./apple-settings-presentation.js";

async function fixture(state: AccessState = "purchased") {
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
  let pending: Promise<unknown> = Promise.resolve();
  const props: AppleSettingsProps = {
    platform: "ios",
    settings: requireModernSettings(cache.currentRecord()),
    access: { ...access, states },
    onGlobalChange: vi.fn((next: boolean) => {
      pending = cache.setGlobalOn(next);
    }),
    onServiceChange: vi.fn((id: ServiceId, next: boolean) => {
      pending = cache.setService(id, next);
    }),
    onFeatureChange: vi.fn((id: FeatureId, next: boolean) => {
      pending = cache.setFeature(id, next);
    }),
    sync: { onSignIn: vi.fn() },
    pro: { ownership: "none", channel: "unverified" },
    sharing: { state: "off", onChange: vi.fn() },
    help: { onGuide: vi.fn(), onSupport: vi.fn(), onPrivacy: vi.fn() },
  };
  return { storage, cache, props, settled: () => pending };
}

describe("controlled D04 Apple settings", () => {
  it("commits free choices without an account and retains saved choices when site or global controls are Off", async () => {
    const { props, storage, cache, settled } = await fixture();
    const view = render(AppleSettings, { props });
    const refresh = async () => {
      await settled();
      props.settings = requireModernSettings(cache.currentRecord());
      await view.rerender(props);
    };
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    const shorts = screen.getByRole("switch", { name: "Shorts" });
    await fireEvent.click(shorts);
    expect(shorts).toHaveAttribute("aria-checked", "true");
    await refresh();
    expect(shorts).toHaveAttribute("aria-checked", "false");
    const comments = screen.getByRole("switch", { name: "Comments" });
    await fireEvent.click(comments);
    await refresh();
    expect(comments).toHaveAttribute("aria-checked", "true");
    await fireEvent.click(
      screen.getByRole("switch", { name: "Still on YouTube" }),
    );
    await refresh();
    const siteOff = await storage.get();
    await fireEvent.click(comments);
    await settled();
    expect(await storage.get()).toEqual(siteOff);
    await fireEvent.click(
      screen.getByRole("switch", { name: "TikTok website" }),
    );
    await refresh();
    expect(requireModernSettings((await storage.get())!).services.tiktok).toBe(
      false,
    );
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await refresh();
    const globalOff = await storage.get();
    await fireEvent.click(comments);
    await fireEvent.click(
      screen.getByRole("switch", { name: "Still on Instagram" }),
    );
    await settled();
    expect(await storage.get()).toEqual(globalOff);
    expect(props.onFeatureChange).toHaveBeenCalledTimes(2);
    expect(props.sync.onSignIn).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each(["ios", "mac"] as const)(
    "keeps one local section and the %s feature inventory without saving on expansion",
    async (platform) => {
      const { props, storage } = await fixture();
      props.platform = platform;
      let open: ServiceId | null = "youtube";
      props.sectionMemory = {
        read: () => open,
        write: vi.fn((value) => {
          open = value;
        }),
      };
      const before = await storage.get();
      const view = render(AppleSettings, { props });
      await fireEvent.click(
        screen.getByRole("button", { name: "Facebook Blocker" }),
      );
      expect(document.querySelectorAll(".service-options.open")).toHaveLength(
        1,
      );
      expect(
        screen.getByRole("button", { name: "YouTube Blocker" }),
      ).toHaveAttribute("aria-expanded", "false");
      expect(
        Boolean(screen.queryByRole("switch", { name: "Desktop sidebar ads" })),
      ).toBe(platform === "mac");
      expect(await storage.get()).toEqual(before);
      view.unmount();
      const next = render(AppleSettings, { props });
      expect(
        screen.getByRole("button", { name: "Facebook Blocker" }),
      ).toHaveAttribute("aria-expanded", "true");
      next.unmount();
    },
  );

  it.each(["checking", "verification_required"] as const)(
    "retains actual saved optional choices during %s and leaves free blocking usable",
    async (state) => {
      const { props, cache, storage, settled } = await fixture();
      await cache.setFeature("youtube.comments", true);
      props.settings = requireModernSettings(cache.currentRecord());
      props.access = {
        ...props.access,
        states: { ...props.access.states, "youtube.comments": state },
      };
      const saved = await storage.get();
      const view = render(AppleSettings, { props });
      await fireEvent.click(
        screen.getByRole("button", { name: "YouTube Blocker" }),
      );
      const held = screen.getByRole("switch", { name: "Comments" });
      expect(held).toHaveAttribute("aria-checked", "true");
      await fireEvent.click(held);
      await settled();
      expect(await storage.get()).toEqual(saved);
      expect(props.onFeatureChange).not.toHaveBeenCalled();
      await fireEvent.click(screen.getByRole("switch", { name: "Shorts" }));
      await settled();
      expect(
        requireModernSettings((await storage.get())!).sites["youtube.shorts"],
      ).toBe(false);
      expect(
        requireModernSettings((await storage.get())!).sites["youtube.comments"],
      ).toBe(true);
      view.unmount();
    },
  );

  it("requests native purchase without an account, retains pending state, and never fabricates a link invitation or sharing", async () => {
    const { props, storage } = await fixture("locked");
    const buy = vi.fn();
    props.pro = {
      ownership: "none",
      channel: "ready",
      offer: { price: "fixture verified localized offer" },
      onBuy: buy,
      onRestore: vi.fn(),
    };
    const saved = await storage.get();
    const view = render(AppleSettings, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "Get Still Pro" }),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Comments. Included in Still Pro. See Still Pro",
      }),
    );
    expect(buy).toHaveBeenCalledTimes(2);
    expect(props.sync.onSignIn).not.toHaveBeenCalled();
    expect(screen.queryByText("fixture verified localized offer")).toBeNull();
    expect(screen.queryByText("Link Still Pro to an account")).toBeNull();
    expect(props.sharing.onChange).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(props.sync.onSignIn).toHaveBeenCalledOnce();
    expect(props.sharing.onChange).not.toHaveBeenCalled();
    props.pro.state = "pending";
    await view.rerender(props);
    const pending = screen.getByRole("button", { name: "Waiting for Apple…" });
    expect(pending).toHaveAttribute("aria-disabled", "true");
    await fireEvent.click(pending);
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Comments. Included in Still Pro. See Still Pro",
      }),
    );
    expect(buy).toHaveBeenCalledTimes(2);
    props.pro = { ...props.pro, ownership: "owned", state: "idle" };
    await view.rerender(props);
    expect(screen.getByText("Still Pro and sync")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    expect(screen.queryByText("Link Still Pro to an account")).toBeNull();
    expect(await storage.get()).toEqual(saved);
    view.unmount();
  });

  it("withholds native sales and locks when the channel, offer, callback, access or Restore is held", async () => {
    const { props } = await fixture("locked");
    const buy = vi.fn();
    const available = {
      ownership: "none" as const,
      channel: "ready" as const,
      offer: { price: "fixture native offer" },
      onBuy: buy,
    };
    props.pro = { ...available };
    const view = render(AppleSettings, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    const held = async () => {
      await view.rerender(props);
      expect(
        screen.queryByRole("button", { name: "Get Still Pro" }),
      ).toBeNull();
      const lock = screen.queryByRole("button", {
        name: "Comments. Included in Still Pro. See Still Pro",
      });
      if (lock) {
        expect(lock).toHaveAttribute("aria-disabled", "true");
        await fireEvent.click(lock);
      }
      expect(buy).not.toHaveBeenCalled();
    };
    for (const channel of ["unverified", "unavailable"] as const) {
      props.pro = { ...available, channel };
      await held();
    }
    props.pro = { ...available, offer: undefined };
    await held();
    props.pro = { ...available, onBuy: undefined };
    await held();
    for (const ownership of ["checking", "verify", "failed"] as const) {
      props.pro = { ...available, ownership };
      await held();
    }
    for (const state of ["failed", "success"] as const) {
      props.pro = { ...available, state };
      await held();
    }
    props.pro = { ...available };
    for (const state of ["checking", "verify", "failed"] as const) {
      props.restore = { state };
      await held();
    }
    props.restore = undefined;
    for (const state of ["checking", "verification_required"] as const) {
      props.access = {
        ...props.access,
        states: { ...props.access.states, "youtube.comments": state },
      };
      await held();
    }
    view.unmount();
  });

  it("renders the native optional-account caption without changing the shared card's default", async () => {
    const plain = render(SyncCard, { props: {} });
    expect(
      screen.queryByText(
        "Optional. Blocking and Still Pro work without an account.",
      ),
    ).toBeNull();
    plain.unmount();
    const { props } = await fixture();
    const view = render(AppleSettings, { props });
    expect(
      screen.getByText(
        "Optional. Blocking and Still Pro work without an account.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Free. Keep your settings updated across every supported surface",
      ),
    ).toBeTruthy();
    props.sync.account = {
      address: "actual-supplied@still.test",
      confirmed: true,
      status: { tone: "success", text: "Settings synced." },
    };
    props.pro.ownership = "owned";
    await view.rerender(props);
    expect(screen.getByText("actual-supplied@still.test")).toBeTruthy();
    expect(screen.getByText("Settings synced.")).toBeTruthy();
    expect(
      screen.queryByText(
        "Optional. Blocking and Still Pro work without an account.",
      ),
    ).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /sam@example.com|Demonstration only/,
    );
    view.unmount();
  });

  it("shows only a supplied eligible later-visit invitation and holds it for consent, setup and errors", async () => {
    const { props, storage } = await fixture();
    props.pro.ownership = "owned";
    const link = vi.fn(),
      dismiss = vi.fn();
    props.linkInvitation = {
      eligibleLaterVisit: false,
      onLink: link,
      onDismiss: dismiss,
    };
    const saved = await storage.get();
    const view = render(AppleSettings, { props });
    expect(screen.queryByText("Link Still Pro to an account")).toBeNull();
    props.linkInvitation.eligibleLaterVisit = true;
    await view.rerender(props);
    await fireEvent.click(screen.getByRole("button", { name: "Link" }));
    await fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(link).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
    props.sharing.state = "unasked";
    await view.rerender(props);
    expect(screen.queryByText("Link Still Pro to an account")).toBeNull();
    props.sharing.state = "off";
    props.setup = {
      title: "Supplied setup",
      detail: "Supplied instructions",
      steps: [],
      actionLabel: "Supplied action",
    };
    await view.rerender(props);
    expect(screen.queryByText("Link Still Pro to an account")).toBeNull();
    props.setup = undefined;
    props.restore = { state: "failed" };
    await view.rerender(props);
    expect(screen.queryByText("Link Still Pro to an account")).toBeNull();
    expect(await storage.get()).toEqual(saved);
    view.unmount();
  });

  it("keeps combined sharing explicit with approved purposes and routes supplied setup/help/link/verification actions", async () => {
    const { props, storage } = await fixture("locked");
    const share = vi.fn(),
      decline = vi.fn(),
      setup = vi.fn(),
      confirm = vi.fn(),
      other = vi.fn(),
      verify = vi.fn();
    props.sharing = { state: "unasked", onShare: share, onDecline: decline };
    props.setup = {
      title: "Caller-approved setup title",
      detail: "Caller-approved setup detail",
      steps: ["Caller-approved step"],
      actionLabel: "Caller-approved action",
      onAction: setup,
    };
    props.link = {
      state: "confirm",
      email: "intended@still.test",
      onConfirm: confirm,
      onChooseOther: other,
    };
    props.restore = { state: "verify", onAction: verify };
    const saved = await storage.get();
    const view = render(AppleSettings, { props });
    await fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(share).not.toHaveBeenCalled();
    props.sharing = {
      ...props.sharing,
      purposesVerified: true,
      purposes: [
        {
          name: "Fixture combined purpose",
          text: "Fixture supplied email-plus-usage purpose.",
        },
      ],
    };
    await view.rerender(props);
    await fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await fireEvent.click(screen.getByRole("button", { name: "Don't share" }));
    expect(share).toHaveBeenCalledOnce();
    expect(decline).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: "Caller-approved action" }),
    );
    expect(setup).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: "Link to this account" }),
    );
    expect(confirm).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: "Use a different account" }),
    );
    expect(other).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole("button", { name: "Verify now" }));
    expect(verify).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: "Contact support" }),
    );
    expect(props.help.onSupport).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: "Privacy policy" }),
    );
    expect(props.help.onPrivacy).toHaveBeenCalledOnce();
    expect(await storage.get()).toEqual(saved);
    expect(screen.queryByText("Your shared data has been deleted.")).toBeNull();
    expect(
      screen.getByText("Share your email and usage data with Still?"),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /every website|\[Provider\]|sam@example.com/,
    );
    view.unmount();
  });

  it("keeps deletion request-only with safe cancellation, keyboard trapping and the current account port", async () => {
    const { props } = await fixture();
    const remove = vi.fn();
    props.sync.account = {
      address: "fixture@still.test",
      confirmed: true,
      onDeleteAccount: remove,
    };
    const view = render(AppleSettings, { props });
    const opener = screen.getByRole("button", { name: "Delete account" });
    opener.focus();
    await fireEvent.click(opener);
    let dialog = screen.getByRole("dialog", { name: "Delete your account?" });
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus();
    await fireEvent.keyDown(window, { key: "Tab" });
    expect(
      within(dialog).getByRole("button", { name: "Delete account" }),
    ).toHaveFocus();
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
    expect(remove).not.toHaveBeenCalled();
    await fireEvent.click(opener);
    dialog = screen.getByRole("dialog");
    props.sync.account.onDeleteAccount = undefined;
    await view.rerender(props);
    expect(
      within(dialog).getByRole("button", { name: "Delete account" }),
    ).toBeDisabled();
    await fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete account" }),
    );
    expect(remove).not.toHaveBeenCalled();
    await fireEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    view.unmount();
  });
});
