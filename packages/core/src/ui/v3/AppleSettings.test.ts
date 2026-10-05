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

/** Existing paid/consent fixtures supply both producers; absence is tested separately. */
type SuppliedProducerProps = AppleSettingsProps &
  Required<Pick<AppleSettingsProps, "pro" | "sharing">>;

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
  const props: SuppliedProducerProps = {
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
      identity: "private-fixture-account",
      revision: 0,
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

// Observe the actual callback passed to the maintained dialog without replacing its DOM,
// focus handling, or dispatch. A retained callback may outlive the rendered opening.
const dialogPort = vi.hoisted(() => ({
  current: undefined as
    | import("./extension-settings-presentation.js").ConfirmationDialogProps
    | undefined,
}));
vi.mock("./ConfirmationDialog.svelte", async (importOriginal) => {
  const { default: Dialog } =
    await importOriginal<typeof import("./ConfirmationDialog.svelte")>();
  return {
    default: (...args: Parameters<typeof Dialog>) => {
      dialogPort.current = args[1];
      return Dialog(...args);
    },
  };
});

function retainedClick(button: HTMLElement) {
  // Svelte 5.57 stores delegated handlers under its event symbol. Retain the real
  // mounted handler so disabled rendering alone cannot satisfy a dispatch guard.
  const key = Object.getOwnPropertySymbols(button).find(
    (symbol) => symbol.description === "events",
  );
  const handler = key
    ? (button as unknown as Record<symbol, { click?: () => void }>)[key]?.click
    : undefined;
  expect(handler).toBeTypeOf("function");
  return () => handler!.call(button);
}

describe("D04 destructive and native recovery port lifetimes", () => {
  it.each(["address", "identity", "revision", "port", "removal", "account"])(
    "invalidates an open deletion consent on %s replacement, including ABA",
    async (change) => {
      const { props } = await fixture();
      const remove = vi.fn(),
        replacement = vi.fn();
      const account = {
        address: "fixture@still.test",
        confirmed: true,
        identity: "account-a",
        revision: 1,
        onDeleteAccount: remove,
      };
      props.sync.account = account;
      const view = render(AppleSettings, { props });
      await fireEvent.click(
        screen.getByRole("button", { name: "Delete account" }),
      );
      const retained = dialogPort.current!.onConfirm!;
      expect(retained).toBeTypeOf("function");
      if (change === "account") props.sync.account = undefined;
      else
        props.sync.account = {
          ...account,
          ...(change === "address" ? { address: "other@still.test" } : {}),
          ...(change === "identity" ? { identity: "account-b" } : {}),
          ...(change === "revision" ? { revision: 2 } : {}),
          ...(change === "port" ? { onDeleteAccount: replacement } : {}),
          ...(change === "removal" ? { onDeleteAccount: undefined } : {}),
        };
      await view.rerender(props);
      retained();
      expect(remove).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
      props.sync.account = account;
      await view.rerender(props);
      retained();
      const dialog = screen.queryByRole("dialog");
      if (dialog) {
        const confirm = within(dialog).getByRole("button", {
          name: "Delete account",
        });
        expect(confirm).toBeDisabled();
        await fireEvent.click(confirm);
        await fireEvent.click(
          within(dialog).getByRole("button", { name: "Cancel" }),
        );
      }
      expect(remove).not.toHaveBeenCalled();
      await fireEvent.click(
        screen.getByRole("button", { name: "Delete account" }),
      );
      retained();
      expect(remove).not.toHaveBeenCalled();
      await fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Delete account",
        }),
      );
      expect(remove).toHaveBeenCalledOnce();
      retained();
      expect(remove).toHaveBeenCalledOnce();
      view.unmount();
    },
  );

  it.each([false, true])(
    "keeps unchanged account identity and epoch eligible across a sync status refresh (explicit tokens: %s)",
    async (explicit) => {
      const { props } = await fixture();
      const remove = vi.fn();
      const account = {
        address: "fixture@still.test",
        confirmed: true,
        identity: "private-fixture-account",
        revision: 0,
        onDeleteAccount: remove,
        ...(explicit ? { identity: "account-a", revision: 1 } : {}),
      };
      props.sync.account = account;
      const view = render(AppleSettings, { props });
      await fireEvent.click(
        screen.getByRole("button", { name: "Delete account" }),
      );
      const retained = dialogPort.current!.onConfirm!;
      props.sync.account = {
        ...account,
        status: { tone: "success", text: "Settings synced." },
      };
      await view.rerender(props);
      await fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Delete account",
        }),
      );
      retained();
      expect(remove).toHaveBeenCalledOnce();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByText("Settings synced.")).toBeTruthy();
      view.unmount();
    },
  );

  it.each(["cancel", "unmount"])(
    "makes a retained deletion confirmation inert after %s and a fresh opening",
    async (end) => {
      const { props } = await fixture();
      const remove = vi.fn();
      props.sync.account = {
        address: "fixture@still.test",
        confirmed: true,
        identity: "private-fixture-account",
        revision: 0,
        onDeleteAccount: remove,
      };
      let view = render(AppleSettings, { props });
      await fireEvent.click(
        screen.getByRole("button", { name: "Delete account" }),
      );
      const retained = dialogPort.current!.onConfirm!;
      if (end === "cancel")
        await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      else {
        view.unmount();
        view = render(AppleSettings, { props });
      }
      retained();
      expect(remove).not.toHaveBeenCalled();
      await fireEvent.click(
        screen.getByRole("button", { name: "Delete account" }),
      );
      retained();
      expect(remove).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeTruthy();
      await fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Delete account",
        }),
      );
      expect(remove).toHaveBeenCalledOnce();
      view.unmount();
    },
  );

  it("guards a retained Restore dispatch during a pending native purchase and resumes only from supplied settled state", async () => {
    const { props, storage } = await fixture("locked");
    const restore = vi.fn(),
      buy = vi.fn();
    props.pro = {
      ownership: "none",
      channel: "ready",
      offer: { price: "fixture native offer" },
      onBuy: buy,
      onRestore: restore,
    };
    const saved = await storage.get();
    const view = render(AppleSettings, { props });
    let button = screen.getByRole("button", { name: "Restore purchase" });
    const retained = retainedClick(button);
    props.pro = { ...props.pro, state: "pending" };
    await view.rerender(props);
    button = screen.getByRole("button", { name: "Restore purchase" });
    expect(button).toBeDisabled();
    await fireEvent.click(button);
    retained();
    expect(restore).not.toHaveBeenCalled();
    props.pro = { ...props.pro, state: "idle" };
    await view.rerender(props);
    expect(button).not.toBeDisabled();
    await fireEvent.click(button);
    expect(restore).toHaveBeenCalledOnce();
    expect(buy).not.toHaveBeenCalled();
    expect(props.sync.onSignIn).not.toHaveBeenCalled();
    expect(await storage.get()).toEqual(saved);
    view.unmount();
  });

  it.each(["failed", "verify"] as const)(
    "holds the explicit Restore %s recovery action while Apple purchase is pending",
    async (state) => {
      const { props } = await fixture("locked");
      const recover = vi.fn();
      props.restore = { state, onAction: recover };
      const view = render(AppleSettings, { props });
      const label = state === "verify" ? "Verify now" : "Try again";
      const button = screen.getByRole("button", { name: label });
      const retained = retainedClick(button);
      props.pro = { ...props.pro, state: "pending" };
      await view.rerender(props);
      expect(button).toBeDisabled();
      retained();
      await fireEvent.click(button);
      expect(recover).not.toHaveBeenCalled();
      props.pro = { ...props.pro, state: "idle" };
      await view.rerender(props);
      await fireEvent.click(button);
      expect(recover).toHaveBeenCalledOnce();
      view.unmount();
    },
  );

  it.each(["checking", "verify", "failed"] as const)(
    "holds mounted and retained purchase retry during Restore %s, then permits supplied eligible retry",
    async (state) => {
      const { props, storage } = await fixture("locked");
      const retry = vi.fn();
      props.pro = {
        ownership: "none",
        channel: "ready",
        offer: { price: "fixture native offer" },
        state: "failed",
        onRetry: retry,
      };
      const saved = await storage.get();
      const view = render(AppleSettings, { props });
      const card = screen.getByRole("region", { name: "Still Pro" });
      const button = within(card).getByRole("button", { name: "Try again" });
      const retained = retainedClick(button);
      props.restore = { state };
      await view.rerender(props);
      const current = within(card).queryByRole("button", { name: "Try again" });
      if (current) {
        expect(current).toBeDisabled();
        await fireEvent.click(current);
      }
      retained();
      expect(retry).not.toHaveBeenCalled();
      props.restore = undefined;
      await view.rerender(props);
      await fireEvent.click(
        within(card).getByRole("button", { name: "Try again" }),
      );
      expect(retry).toHaveBeenCalledOnce();
      expect(screen.getByText("The purchase wasn't confirmed.")).toBeTruthy();
      expect(
        screen.queryByText("Still Pro is ready. New controls start off."),
      ).toBeNull();
      expect(props.sync.onSignIn).not.toHaveBeenCalled();
      expect(await storage.get()).toEqual(saved);
      view.unmount();
    },
  );

  it.each(["access", "ownership", "channel", "offer", "callback", "state"])(
    "guards purchase retry against current %s eligibility at dispatch time",
    async (change) => {
      const { props } = await fixture("locked");
      const retry = vi.fn();
      props.pro = {
        ownership: "none",
        channel: "ready",
        offer: { price: "fixture native offer" },
        state: "failed",
        onRetry: retry,
      };
      const view = render(AppleSettings, { props });
      const retained = retainedClick(
        screen.getByRole("button", { name: "Try again" }),
      );
      if (change === "access")
        props.access = {
          ...props.access,
          states: {
            ...props.access.states,
            "youtube.comments": "verification_required",
          },
        };
      if (change === "ownership")
        props.pro = { ...props.pro, ownership: "checking" };
      if (change === "channel")
        props.pro = { ...props.pro, channel: "unverified" };
      if (change === "offer") props.pro = { ...props.pro, offer: undefined };
      if (change === "callback")
        props.pro = { ...props.pro, onRetry: undefined };
      if (change === "state") props.pro = { ...props.pro, state: "pending" };
      await view.rerender(props);
      retained();
      expect(retry).not.toHaveBeenCalled();
      view.unmount();
    },
  );

  it("preserves one account-free recovery-only action for verify ownership without an explicit Restore presentation", async () => {
    const { props, storage } = await fixture("verification_required");
    const restore = vi.fn(),
      buy = vi.fn();
    props.pro = {
      ownership: "verify",
      channel: "ready",
      offer: { price: "fixture native offer" },
      onBuy: buy,
      onRestore: restore,
    };
    const saved = await storage.get();
    const view = render(AppleSettings, { props });
    expect(
      screen.getByText("Still Pro needs to be verified again."),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Restore purchase" }),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    await fireEvent.click(
      screen.getByRole("button", { name: "Restore purchase" }),
    );
    expect(restore).toHaveBeenCalledOnce();
    props.pro = { ...props.pro, state: "pending" };
    await view.rerender(props);
    expect(
      screen.getByRole("button", { name: "Restore purchase" }),
    ).toBeDisabled();
    props.pro = { ...props.pro, state: "idle" };
    props.restore = { state: "verify", onAction: restore };
    await view.rerender(props);
    expect(
      screen.getAllByText("Still Pro needs to be verified again."),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Restore purchase" }),
    ).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Verify now" }));
    expect(restore).toHaveBeenCalledTimes(2);
    expect(buy).not.toHaveBeenCalled();
    expect(props.sync.onSignIn).not.toHaveBeenCalled();
    expect(await storage.get()).toEqual(saved);
    view.unmount();
  });
});

// Real mount and live caller getters expose replacements before Svelte flushes the DOM.
import { flushSync, mount, unmount } from "svelte";
import { SvelteMap } from "svelte/reactivity";

function mountCurrentCaller(props: AppleSettingsProps) {
  const current = new SvelteMap<string, unknown>([
    ["sync", props.sync],
    ["pro", props.pro],
    ["restore", props.restore],
  ]);
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AppleSettings, {
    target,
    props: {
      ...props,
      get sync() {
        return current.get("sync") as AppleSettingsProps["sync"];
      },
      get pro() {
        return current.get("pro") as AppleSettingsProps["pro"];
      },
      get restore() {
        return current.get("restore") as AppleSettingsProps["restore"];
      },
    },
  });
  flushSync();
  let destroyed = false;
  return {
    current,
    destroy: async () => {
      if (destroyed) return;
      destroyed = true;
      await unmount(component);
      target.remove();
    },
  };
}

// Deliberately invalid untyped caller input, never a default or host producer.
function invalidDeleteAccount(account: unknown): AppleSettingsProps["sync"] {
  return { account } as AppleSettingsProps["sync"];
}
const deletionFixtureTokens = { identity: "private-account-a", revision: 0 };

describe("D04 current destructive epoch and Restore recovery boundaries", () => {
  it.each(["tokenless", "identity-only"] as const)(
    "rejects retained consent after a %s same-account session replacement with a stable dispatcher",
    async (replacement) => {
      const { props, storage } = await fixture();
      const remove = vi.fn();
      const account = {
        address: "private-fixture@still.test",
        confirmed: true,
        ...deletionFixtureTokens,
        onDeleteAccount: remove,
      };
      props.sync = { account };
      const saved = await storage.get();
      const view = mountCurrentCaller(props);
      try {
        await fireEvent.click(
          screen.getByRole("button", { name: "Delete account" }),
        );
        const retained = dialogPort.current!.onConfirm!;
        expect(retained).toBeTypeOf("function");
        view.current.set(
          "sync",
          invalidDeleteAccount({
            address: account.address,
            confirmed: account.confirmed,
            onDeleteAccount: remove,
            ...(replacement === "identity-only"
              ? { identity: account.identity }
              : {}),
          }),
        );
        retained();
        expect(remove).not.toHaveBeenCalled();
        flushSync();
        retained();
        expect(remove).not.toHaveBeenCalled();
        view.current.set("sync", { account });
        flushSync();
        retained();
        expect(remove).not.toHaveBeenCalled();
        const dialog = screen.queryByRole("dialog");
        if (dialog)
          await fireEvent.click(
            within(dialog).getByRole("button", { name: "Cancel" }),
          );
        await fireEvent.click(
          screen.getByRole("button", { name: "Delete account" }),
        );
        retained();
        expect(remove).not.toHaveBeenCalled();
        const fresh = dialogPort.current!.onConfirm!;
        fresh();
        fresh();
        expect(remove).toHaveBeenCalledOnce();
        expect(await storage.get()).toEqual(saved);
      } finally {
        await view.destroy();
      }
    },
  );

  it.each([
    {},
    { identity: "private-account-a" },
    { identity: "", revision: 0 },
    { identity: "   ", revision: 0 },
    { identity: "private-account-a", revision: "" },
    { identity: "private-account-a", revision: "   " },
    { identity: "private-account-a", revision: NaN },
    { identity: "private-account-a", revision: Infinity },
    { identity: "private-account-a", revision: -1 },
    { identity: "private-account-a", revision: 0.5 },
    { identity: "private-account-a", revision: null },
  ])("keeps malformed deletion caller inert (%j)", async (tokens) => {
    const { props } = await fixture();
    const remove = vi.fn();
    props.sync = invalidDeleteAccount({
      address: "private-fixture@still.test",
      confirmed: true,
      onDeleteAccount: remove,
      ...tokens,
    });
    const view = mountCurrentCaller(props);
    try {
      const opener = screen.queryByRole("button", { name: "Delete account" });
      if (opener) await fireEvent.click(opener);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      await view.destroy();
    }
  });

  it.each([0, "private-session-0"])(
    "preserves valid epoch %s on status-only refresh and consumes consent before reentrant dispatch",
    async (revision) => {
      const { props } = await fixture();
      let retained: () => void;
      const remove = vi.fn(() => retained());
      const account = {
        address: "private-fixture@still.test",
        confirmed: true,
        identity: "private-account-a",
        revision,
        onDeleteAccount: remove,
      };
      props.sync = { account };
      const view = mountCurrentCaller(props);
      try {
        await fireEvent.click(
          screen.getByRole("button", { name: "Delete account" }),
        );
        retained = dialogPort.current!.onConfirm!;
        view.current.set("sync", {
          account: {
            ...account,
            status: { tone: "success", text: "Settings synced." },
          },
        });
        retained();
        expect(remove).toHaveBeenCalledOnce();
        flushSync();
        retained();
        expect(remove).toHaveBeenCalledOnce();
      } finally {
        await view.destroy();
      }
      retained!();
      expect(remove).toHaveBeenCalledOnce();
    },
  );

  it.each(["tokenless", "identity-only"] as const)(
    "cannot open or reuse consent from an initially %s same-shape session",
    async (shape) => {
      const { props } = await fixture();
      const remove = vi.fn();
      const account = {
        address: "private-fixture@still.test",
        confirmed: true,
        onDeleteAccount: remove,
        ...(shape === "identity-only" ? { identity: "private-account-a" } : {}),
      };
      props.sync = invalidDeleteAccount(account);
      const view = mountCurrentCaller(props);
      try {
        const button = screen.queryByRole("button", { name: "Delete account" });
        const oldOpening = button ? retainedClick(button) : undefined;
        if (button) await fireEvent.click(button);
        const oldConsent = dialogPort.current?.onConfirm;
        view.current.set("sync", invalidDeleteAccount({ ...account }));
        oldOpening?.();
        oldConsent?.();
        expect(remove).not.toHaveBeenCalled();
        expect(screen.queryByRole("dialog")).toBeNull();
        flushSync();
        oldOpening?.();
        oldConsent?.();
        expect(remove).not.toHaveBeenCalled();
      } finally {
        await view.destroy();
      }
    },
  );

  it.each([
    "checking",
    "restored",
    "nothing",
    "removed",
    "pending",
    "no-action",
  ] as const)(
    "silences retained Restore recovery in current %s state before and after DOM flush",
    async (state) => {
      const { props, storage } = await fixture("locked");
      const oldAction = vi.fn(),
        currentAction = vi.fn();
      props.restore = { state: "failed", onAction: oldAction };
      const saved = await storage.get();
      const view = mountCurrentCaller(props);
      try {
        const retained = retainedClick(
          screen.getByRole("button", { name: "Try again" }),
        );
        view.current.set(
          "restore",
          state === "removed"
            ? undefined
            : {
                state:
                  state === "pending" || state === "no-action"
                    ? "verify"
                    : state,
                onAction: state === "no-action" ? undefined : currentAction,
              },
        );
        if (state === "pending")
          view.current.set("pro", { ...props.pro, state: "pending" });
        retained();
        expect(oldAction).not.toHaveBeenCalled();
        expect(currentAction).not.toHaveBeenCalled();
        flushSync();
        retained();
        expect(oldAction).not.toHaveBeenCalled();
        expect(currentAction).not.toHaveBeenCalled();
        expect(props.sync.onSignIn).not.toHaveBeenCalled();
        expect(await storage.get()).toEqual(saved);
        await view.destroy();
        retained();
        expect(currentAction).not.toHaveBeenCalled();
      } finally {
        await view.destroy();
      }
    },
  );

  it.each(["failed", "verify"] as const)(
    "dispatches only the healthy current %s Restore port and stops after unmount",
    async (state) => {
      const { props } = await fixture("locked");
      const oldAction = vi.fn(),
        currentAction = vi.fn();
      props.restore = { state: "failed", onAction: oldAction };
      const view = mountCurrentCaller(props);
      try {
        const retained = retainedClick(
          screen.getByRole("button", { name: "Try again" }),
        );
        view.current.set("restore", { state, onAction: currentAction });
        retained();
        expect(oldAction).not.toHaveBeenCalled();
        expect(currentAction).toHaveBeenCalledOnce();
        flushSync();
        await fireEvent.click(
          screen.getByRole("button", {
            name: state === "verify" ? "Verify now" : "Try again",
          }),
        );
        expect(currentAction).toHaveBeenCalledTimes(2);
        await view.destroy();
        retained();
        expect(currentAction).toHaveBeenCalledTimes(2);
      } finally {
        await view.destroy();
      }
    },
  );
});

it("requires explicit account/session tokens only for the typed deletion-enabled contract", () => {
  type Account = NonNullable<AppleSettingsProps["sync"]["account"]>;
  const readOnly: Account = {
    address: "private-fixture@still.test",
    confirmed: true,
  };
  const remove = vi.fn();
  // @ts-expect-error Deletion-enabled callers must supply actual identity and a session epoch.
  const tokenless: Account = { ...readOnly, onDeleteAccount: remove };
  // @ts-expect-error An account identity without a destructive/session epoch is insufficient.
  const identityOnly: Account = {
    ...readOnly,
    identity: "private-account-a",
    onDeleteAccount: remove,
  };
  const deletionEnabled: Account = {
    ...readOnly,
    ...deletionFixtureTokens,
    onDeleteAccount: remove,
  };
  expect(readOnly.onDeleteAccount).toBeUndefined();
  expect(deletionEnabled.revision).toBe(0);
  expect(tokenless.onDeleteAccount).toBe(remove);
  expect(identityOnly.onDeleteAccount).toBe(remove);
  expect(remove).not.toHaveBeenCalled();
});

const PRO_LOCK = "Comments. Included in Still Pro. See Still Pro";

/** Present controls report "disabled" only through aria-disabled="true". */
function rowControl(role: "button" | "switch", name: string) {
  const control = screen.queryByRole(role, { name });
  if (control === null) return "absent";
  return control.getAttribute("aria-disabled") === "true"
    ? "disabled"
    : "enabled";
}

describe("D04 optional paid and combined-consent producers", () => {
  it.each([
    { state: "locked", row: { lock: "disabled", toggle: "absent" } },
    { state: "checking", row: { lock: "absent", toggle: "disabled" } },
    {
      state: "verification_required",
      row: { lock: "absent", toggle: "disabled" },
    },
    { state: "purchased", row: { lock: "absent", toggle: "enabled" } },
  ] as const)(
    "omits every paid offer surface without a paid producer while supplied Restore stays operational ($state access)",
    async ({ state, row }) => {
      const { props, storage } = await fixture(state);
      const recover = vi.fn();
      const link = vi.fn();
      const saved = await storage.get();
      const view = render(AppleSettings, {
        props: {
          ...props,
          pro: undefined,
          restore: { state: "failed", onAction: recover },
          linkInvitation: { eligibleLaterVisit: true, onLink: link },
        },
      });
      expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Get Still Pro" }),
      ).toBeNull();
      expect(screen.queryByText("Checking your Still Pro access…")).toBeNull();
      expect(
        screen.queryByText("Still Pro needs to be verified again."),
      ).toBeNull();
      expect(
        screen.queryByText("No account needed. Payment is handled by Apple."),
      ).toBeNull();
      expect(screen.getByText("Settings sync")).toBeVisible();
      expect(screen.queryByText("Still Pro and sync")).toBeNull();
      expect(screen.queryByText("Purchased")).toBeNull();
      expect(screen.queryByText("Link Still Pro to an account")).toBeNull();
      await fireEvent.click(
        screen.getByRole("button", { name: "YouTube Blocker" }),
      );
      expect({
        lock: rowControl("button", PRO_LOCK),
        toggle: rowControl("switch", "Comments"),
      }).toEqual(row);
      expect(
        screen.getByText("We couldn't finish checking. Nothing changed."),
      ).toBeVisible();
      await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(recover).toHaveBeenCalledOnce();
      expect(link).not.toHaveBeenCalled();
      expect(props.sync.onSignIn).not.toHaveBeenCalled();
      expect(await storage.get()).toEqual(saved);
      view.unmount();
    },
  );

  it("keeps a known-missing lock row inert to purchase without a paid producer", async () => {
    const { props, storage } = await fixture("locked");
    const saved = await storage.get();
    const view = render(AppleSettings, { props: { ...props, pro: undefined } });
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    const lock = screen.getByRole("button", { name: PRO_LOCK });
    expect(lock).toHaveAttribute("aria-disabled", "true");
    await fireEvent.click(lock);
    expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull();
    expect(props.onFeatureChange).not.toHaveBeenCalled();
    expect(props.sync.onSignIn).not.toHaveBeenCalled();
    expect(await storage.get()).toEqual(saved);
    view.unmount();
  });

  it.each(["off", "absent"] as const)(
    "never shows the link invitation without a paid producer, even when every other gate is open (sharing %s)",
    async (sharingState) => {
      const { props } = await fixture("purchased");
      const onLink = vi.fn();
      const onDismiss = vi.fn();
      const view = render(AppleSettings, {
        props: {
          ...props,
          pro: undefined,
          restore: undefined,
          setup: undefined,
          link: undefined,
          sharing:
            sharingState === "off"
              ? { state: "off", onChange: vi.fn() }
              : undefined,
          linkInvitation: { eligibleLaterVisit: true, onLink, onDismiss },
        },
      });
      expect(screen.queryByText("Link Still Pro to an account")).toBeNull();
      expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
      expect(onLink).not.toHaveBeenCalled();
      expect(onDismiss).not.toHaveBeenCalled();
      view.unmount();
    },
  );

  it("shows an owner's eligible invitation alongside supplied privacy actions when no combined-consent producer is supplied", async () => {
    const { createRawSnippet } = await import("svelte");
    const privacyActions = createRawSnippet(() => ({
      render: () =>
        '<button type="button">Keep legacy usage sharing off</button>',
    }));
    const { props } = await fixture("purchased");
    const onLink = vi.fn();
    const onDismiss = vi.fn();
    const view = render(AppleSettings, {
      props: {
        ...props,
        pro: { ownership: "owned", channel: "unverified" },
        restore: undefined,
        setup: undefined,
        link: undefined,
        sharing: undefined,
        privacyActions,
        linkInvitation: { eligibleLaterVisit: true, onLink, onDismiss },
      },
    });
    // HANDOFF.md §6: invitations "Never during setup, consent, errors, purchase or Restore"; no consent card is shown.
    expect(
      screen.queryByText("Share your email and usage data with Still?"),
    ).toBeNull();
    expect(screen.getByText("Link Still Pro to an account")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Keep legacy usage sharing off" }),
    ).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(onLink).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
    view.unmount();
  });

  it("renders supplied privacy actions in the sharing position only when no combined-consent producer is supplied", async () => {
    const { createRawSnippet } = await import("svelte");
    const optOut = vi.fn();
    const privacyActions = createRawSnippet(() => ({
      render: () =>
        '<button type="button">Keep legacy usage sharing off</button>',
      setup: (node) => {
        node.addEventListener("click", optOut);
        return () => node.removeEventListener("click", optOut);
      },
    }));
    const { props } = await fixture("free");
    const restore = { state: "nothing" as const };
    const helpSection = () =>
      screen.getByRole("heading", { name: "Help" }).closest("section");
    const view = render(AppleSettings, {
      props: { ...props, pro: undefined, restore, sharing: undefined },
    });
    expect(
      screen.queryByText("Share your email and usage data with Still?"),
    ).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Share email and usage data" }),
    ).toBeNull();
    const restoreCard = screen
      .getByText("No Still Pro purchase was found for this account.")
      .closest("section");
    expect(helpSection()?.previousElementSibling).toBe(restoreCard);
    await view.rerender({
      ...props,
      pro: undefined,
      restore,
      sharing: undefined,
      privacyActions,
    });
    const action = screen.getByRole("button", {
      name: "Keep legacy usage sharing off",
    });
    expect(restoreCard?.nextElementSibling).toBe(action);
    expect(helpSection()?.previousElementSibling).toBe(action);
    await fireEvent.click(action);
    expect(optOut).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("switch", { name: "Share email and usage data" }),
    ).toBeNull();
    await view.rerender({ ...props, restore, privacyActions });
    expect(
      screen.getByRole("switch", { name: "Share email and usage data" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Keep legacy usage sharing off" }),
    ).toBeNull();
    expect(props.sharing.onChange).not.toHaveBeenCalled();
    view.unmount();
  });
});
