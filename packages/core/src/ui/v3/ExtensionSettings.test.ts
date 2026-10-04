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
import ExtensionSettings from "./ExtensionSettings.svelte";
import SharingCard from "./SharingCard.svelte";
import type { ExtensionSettingsProps } from "./extension-settings-presentation.js";

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
  const props: ExtensionSettingsProps = {
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

describe("controlled D03 extension settings", () => {
  it("qualifies signed-out sync coverage and removes the invitation when signed in", async () => {
    const { props } = await fixture();
    const view = render(ExtensionSettings, { props });
    const invitation =
      "Free. Keep your settings updated across every supported surface";
    expect(screen.getByText(invitation)).toBeVisible();
    expect(screen.queryByText(/every device and browser/)).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();

    props.sync.account = { address: "fixture@still.test", confirmed: true };
    await view.rerender(props);
    expect(screen.getByText("fixture@still.test")).toBeVisible();
    expect(screen.queryByText(invitation)).toBeNull();
    expect(screen.queryByText(/every device and browser/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    view.unmount();
  });

  it("uses actual free writer requests without a sign-in gate, preserves saved choices and guards Off writes", async () => {
    const { storage, cache, props, settled } = await fixture();
    const view = render(ExtensionSettings, { props });
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
    expect(
      requireModernSettings((await storage.get())!).sites["youtube.comments"],
    ).toBe(true);
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await refresh();
    const globalOff = await storage.get();
    await fireEvent.click(comments);
    await fireEvent.click(
      screen.getByRole("switch", { name: "Still on Instagram" }),
    );
    await settled();
    expect(await storage.get()).toEqual(globalOff);
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await fireEvent.click(screen.getByRole("button", { name: "Setup guide" }));
    await fireEvent.click(
      screen.getByRole("switch", { name: "Share email and usage data" }),
    );
    expect(props.sync.onSignIn).toHaveBeenCalledOnce();
    expect(props.help.onGuide).toHaveBeenCalledOnce();
    expect(props.sharing.onChange).toHaveBeenCalledWith(true);
    expect(props.onFeatureChange).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("keeps one remembered section locally, includes desktop ads, and does not write choices on expansion", async () => {
    const { props, storage } = await fixture();
    let memory: ServiceId | null = "youtube";
    props.sectionMemory = {
      read: () => memory,
      write: vi.fn((value) => {
        memory = value;
      }),
    };
    const before = await storage.get();
    const view = render(ExtensionSettings, { props });
    expect(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    ).toHaveAttribute("aria-expanded", "true");
    await fireEvent.click(
      screen.getByRole("button", { name: "Facebook Blocker" }),
    );
    expect(document.querySelectorAll(".service-options.open")).toHaveLength(1);
    expect(
      screen.getByRole("switch", { name: "Desktop sidebar ads" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "TikTok Blocker" })).toBeNull();
    expect(await storage.get()).toEqual(before);
    view.unmount();
    const restored = render(ExtensionSettings, { props });
    expect(
      screen.getByRole("button", { name: "Facebook Blocker" }),
    ).toHaveAttribute("aria-expanded", "true");
    restored.unmount();
  });

  it("retains saved optional intentions across access uncertainty and keeps free controls usable", async () => {
    const { props, cache, storage, settled } = await fixture();
    await cache.setFeature("youtube.comments", true);
    props.settings = requireModernSettings(cache.currentRecord());
    const saved = await storage.get();
    const view = render(ExtensionSettings, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    for (const state of [
      "checking",
      "verification_required",
      "unsupported",
      "locked",
      "protected",
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
      if (state === "checking" || state === "verification_required") {
        const input = within(row).getByRole("switch", { name: "Comments" });
        expect(input).toHaveAttribute("aria-checked", "true");
        expect(input).toHaveAttribute("aria-disabled", "true");
        await fireEvent.click(input);
      } else if (state === "unsupported")
        expect(within(row).queryByRole("switch")).toBeNull();
      await settled();
      expect(await storage.get()).toEqual(saved);
      expect(props.onFeatureChange).not.toHaveBeenCalled();
    }
    await fireEvent.click(screen.getByRole("switch", { name: "Shorts" }));
    await settled();
    expect(
      requireModernSettings((await storage.get())!).sites["youtube.shorts"],
    ).toBe(false);
    expect(
      requireModernSettings((await storage.get())!).sites["youtube.comments"],
    ).toBe(true);
    view.unmount();
  });

  it("requires actual channel, verified offer and confirmed account for checkout, withholding sales on held access or Restore", async () => {
    const { props } = await fixture("locked");
    const onBuy = vi.fn();
    const onSignIn = vi.fn();
    props.pro = {
      ownership: "none",
      channel: "unverified",
      offer: { price: "test localized offer" },
      onBuy,
      onSignIn,
      onRestore: vi.fn(),
    };
    const view = render(ExtensionSettings, { props });
    expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    props.pro.channel = "ready";
    await view.rerender(props);
    await fireEvent.click(
      screen.getByRole("button", { name: "Get Still Pro" }),
    );
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(onBuy).not.toHaveBeenCalled();
    props.sync.account = { address: "fixture@still.test", confirmed: false };
    await view.rerender(props);
    await fireEvent.click(
      screen.getByRole("button", { name: "Get Still Pro" }),
    );
    expect(onBuy).not.toHaveBeenCalled();
    props.sync.account.confirmed = true;
    await view.rerender(props);
    await fireEvent.click(
      screen.getByRole("button", { name: "Get Still Pro" }),
    );
    expect(onBuy).toHaveBeenCalledOnce();
    for (const state of ["checking", "verification_required"] as const) {
      props.access = {
        ...props.access,
        states: { ...props.access.states, "youtube.comments": state },
      };
      await view.rerender(props);
      expect(
        screen.queryByRole("button", { name: "Get Still Pro" }),
      ).toBeNull();
    }
    props.access = {
      ...props.access,
      states: { ...props.access.states, "youtube.comments": "locked" },
    };
    for (const state of ["checking", "verify", "failed"] as const) {
      props.restore = { state, onAction: vi.fn() };
      await view.rerender(props);
      expect(
        screen.queryByRole("button", { name: "Get Still Pro" }),
      ).toBeNull();
    }
    expect(document.body.textContent).not.toContain("test localized offer");
    expect(onBuy).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("keeps combined consent controlled and requires supplied approved purposes before affirmative sharing", async () => {
    const { props } = await fixture();
    const onShare = vi.fn();
    const onDecline = vi.fn();
    props.sharing = { state: "unasked", onShare, onDecline };
    const view = render(ExtensionSettings, { props });
    expect(document.body.textContent).not.toMatch(
      /\[Provider\]|approved purpose text/i,
    );
    await fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(onShare).not.toHaveBeenCalled();
    props.sharing = {
      ...props.sharing,
      purposesVerified: true,
      purposes: [
        {
          name: "Fixture combined purpose",
          text: "Fixture supplied email plus usage purpose.",
        },
      ],
    };
    await view.rerender(props);
    await fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(onShare).toHaveBeenCalledOnce();
    expect(
      screen.getByText("Share your email and usage data with Still?"),
    ).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Don't share" }));
    expect(onDecline).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onShare).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("switch", { name: "Share email and usage data" }),
    ).toBeNull();
    view.unmount();
  });

  it("reports actual withdrawal and link/restore states without claiming requested work has finished", async () => {
    const { props } = await fixture();
    const retry = vi.fn();
    props.sharing = {
      state: "off",
      withdrawal: "requested",
      onChange: vi.fn(),
      onRetry: retry,
    };
    props.link = { state: "pending", email: "fixture@still.test" };
    props.restore = { state: "checking" };
    const view = render(ExtensionSettings, { props });
    expect(
      screen.getByText(
        "Deletion requested. Your shared data hasn't been deleted yet.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Your shared data has been deleted.")).toBeNull();
    expect(
      screen.getByText("Linking Still Pro to fixture@still.test…"),
    ).toBeTruthy();
    expect(screen.getByText("Checking for Still Pro purchases…")).toBeTruthy();
    props.sharing.withdrawal = "failed";
    props.restore = { state: "failed" };
    await view.rerender(props);
    const share = screen.getByRole("switch", {
      name: "Share email and usage data",
    });
    expect(share).toHaveAttribute("aria-checked", "false");
    await fireEvent.click(share);
    expect(props.sharing.onChange).not.toHaveBeenCalled();
    const sharing = share.closest("section")!;
    await fireEvent.click(
      within(sharing).getByRole("button", { name: "Try again" }),
    );
    expect(retry).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("No Still Pro purchase was found for this account."),
    ).toBeNull();
    view.unmount();
  });

  it("routes only supplied setup/help/sync/link actions without sample accounts or fabricated success", async () => {
    const { props } = await fixture();
    const setup = vi.fn();
    const retry = vi.fn();
    const confirm = vi.fn();
    const other = vi.fn();
    props.setup = {
      detail: "Caller-supplied verified setup instructions.",
      onAction: setup,
    };
    props.sync.account = {
      address: "fixture@still.test",
      confirmed: true,
      status: {
        tone: "failed",
        text: "Sync didn't finish.",
        detail: "Your settings are saved on this device.",
        actionLabel: "Try again",
        onAction: retry,
      },
    };
    props.link = {
      state: "confirm",
      email: "intended@still.test",
      onConfirm: confirm,
      onChooseOther: other,
    };
    const view = render(ExtensionSettings, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "Review permissions" }),
    );
    expect(setup).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: "Link to this account" }),
    );
    expect(confirm).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: "Use a different account" }),
    );
    expect(other).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: "Contact support" }),
    );
    expect(props.help.onSupport).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: "Privacy policy" }),
    );
    expect(props.help.onPrivacy).toHaveBeenCalledOnce();
    expect(screen.getByText("Sync didn't finish.")).toBeTruthy();
    expect(screen.queryByText("Settings synced.")).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /sam@example.com|Demonstration only|\[Provider\]/,
    );
    view.unmount();
  });

  it("confirms deletion safely with actual focus trapping, cancellation, opener restoration and listener teardown", async () => {
    const { props } = await fixture();
    const remove = vi.fn();
    props.sync.account = {
      address: "fixture@still.test",
      confirmed: true,
      onDeleteAccount: remove,
    };
    const view = render(ExtensionSettings, { props });
    const opener = screen.getByRole("button", { name: "Delete account" });
    opener.focus();
    await fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Delete your account?" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const confirm = within(dialog).getByRole("button", {
      name: "Delete account",
    });
    expect(cancel).toHaveFocus();
    expect(remove).not.toHaveBeenCalled();
    await fireEvent.keyDown(window, { key: "Tab" });
    expect(confirm).toHaveFocus();
    await fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(cancel).toHaveFocus();
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
    expect(remove).not.toHaveBeenCalled();
    await fireEvent.click(opener);
    await fireEvent.click(document.querySelector(".scrim")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
    await fireEvent.click(opener);
    await fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete account",
      }),
    );
    expect(remove).toHaveBeenCalledOnce();
    expect(screen.queryByText("Your account has been deleted.")).toBeNull();
    view.unmount();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const key = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it.each(["none", "requested", "verifying"] as const)(
    "keeps the %s sharing switch controlled until the caller reports a changed device choice",
    async (withdrawal) => {
      const change = vi.fn();
      const view = render(SharingCard, {
        props: { state: "off", withdrawal, onChange: change },
      });
      const toggle = screen.getByRole("switch", {
        name: "Share email and usage data",
      });
      await fireEvent.click(toggle);
      expect(change).toHaveBeenCalledWith(true);
      expect(toggle).toHaveAttribute("aria-checked", "false");
      expect(
        screen.queryByText("Your shared data has been deleted."),
      ).toBeNull();
      await view.rerender({ state: "on", onChange: change });
      expect(toggle).toHaveAttribute("aria-checked", "true");
      view.unmount();
    },
  );
});
