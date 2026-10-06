import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import { FEATURE_REGISTRY, type ServiceId } from "@still/shared-types";
import { requireModernSettings } from "../../storage/atomic-settings.js";
import { fixture } from "./ExtensionSettings.test-fixtures.js";
import ExtensionSettings from "./ExtensionSettings.svelte";
import SharingCard from "./SharingCard.svelte";

/**
 * Owner decision 41: a locked row opens the Still Pro sheet; only the sheet's own explicit
 * "Get Still Pro" reaches a purchase or sign-in port. The sheet is closed again with its X.
 */
async function requestThroughLock(feature = "Comments") {
  const row = screen.queryByRole("button", {
    name: "Still Pro",
    description: feature,
  });
  if (!row) return;
  await fireEvent.click(row);
  const sheet = screen.queryByRole("dialog", { name: "Still Pro" });
  if (!sheet) return;
  const buy = within(sheet).queryByRole("button", { name: "Get Still Pro" });
  if (buy) await fireEvent.click(buy);
  await fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog", { name: "Still Pro" })).toBeNull();
}

describe("controlled D03 extension settings", () => {
  it("invalidates deletion when only the account address changes with the same handler", async () => {
    const { props } = await fixture();
    const remove = vi.fn();
    props.sync.account = {
      address: "first@fixture.test",
      confirmed: true,
      onDeleteAccount: remove,
    };
    const view = render(ExtensionSettings, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "Delete account" }),
    );
    props.sync.account.address = "second@fixture.test";
    await view.rerender(props);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    await fireEvent.click(
      screen.getByRole("button", { name: "Delete account" }),
    );
    await fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete account",
      }),
    );
    expect(remove).toHaveBeenCalledOnce();
    view.unmount();
  });

  it.each(["verify", "failed", "operation-failed"] as const)(
    "preserves explicit %s status over an actual checking observation",
    async (status) => {
      const { props } = await fixture("checking");
      if (status === "operation-failed") props.pro.state = "failed";
      else props.pro.ownership = status;
      const view = render(ExtensionSettings, { props });
      expect(screen.queryByText("Checking your Still Pro access…")).toBeNull();
      expect(
        screen.getByText(
          status === "verify"
            ? "Still Pro needs to be verified again."
            : status === "failed"
              ? "We couldn't finish checking. Nothing changed."
              : "The purchase wasn't confirmed.",
        ),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Get Still Pro" }),
      ).toBeNull();
      view.unmount();
    },
  );

  it("holds failed withdrawal with verified purposes and reopens sharing only for a current none result", async () => {
    const { props } = await fixture();
    props.sharing.withdrawal = "failed";
    const view = render(ExtensionSettings, { props });
    const toggle = screen.getByRole("switch", {
      name: "Share email and usage data",
    });
    await fireEvent.click(toggle);
    expect(props.sharing.onChange).not.toHaveBeenCalled();
    props.sharing.withdrawal = "none";
    await view.rerender(props);
    await fireEvent.click(toggle);
    expect(props.sharing.onChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    view.unmount();
  });

  it.each(
    [false, true].flatMap((confirmed) =>
      (
        ["purchased", "protected", "free", "unsupported", "locked"] as const
      ).map((state) => ({ confirmed, state })),
    ),
  )(
    "holds retained purchase ports after success with $state access and confirmed=$confirmed",
    async ({ confirmed, state }) => {
      const { props, storage } = await fixture("locked");
      const buy = vi.fn(),
        signIn = vi.fn();
      props.sectionMemory = { read: () => "youtube", write: vi.fn() };
      props.sync.account = { address: "fixture@still.test", confirmed };
      props.pro = {
        ownership: "none",
        channel: "ready",
        state: "idle",
        offer: { price: "Fixture localized price" },
        onBuy: buy,
        onSignIn: signIn,
      };
      const view = render(ExtensionSettings, { props });
      const requestBoth = async () => {
        const card = screen.queryByRole("button", { name: "Get Still Pro" });
        if (card) await fireEvent.click(card);
        await requestThroughLock();
      };
      await requestBoth();
      expect(confirmed ? buy : signIn).toHaveBeenCalledTimes(2);
      expect(confirmed ? signIn : buy).not.toHaveBeenCalled();
      const saved = await storage.get();
      props.pro.state = "success";
      props.access = {
        ...props.access,
        states: Object.fromEntries(
          Object.entries(props.access.states).map(([id, prior]) => [
            id,
            FEATURE_REGISTRY.some((row) => row.id === id && row.tier === "pro")
              ? state
              : prior,
          ]),
        ) as typeof props.access.states,
      };
      await view.rerender(props);
      await requestBoth();
      expect(confirmed ? buy : signIn).toHaveBeenCalledTimes(2);
      expect(confirmed ? signIn : buy).not.toHaveBeenCalled();
      expect(
        screen.getByText("Still Pro is ready. New controls start off."),
      ).toBeVisible();
      expect(screen.queryByText("Checking your Still Pro access…")).toBeNull();
      expect(
        screen.queryByText("Still Pro can't be bought here yet."),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Get Still Pro" }),
      ).toBeNull();
      expect(await storage.get()).toEqual(saved);
      view.unmount();
    },
  );

  it.each(["purchased", "protected", "free", "unsupported"] as const)(
    "withholds a new card offer from completed %s access without manufacturing checking",
    async (state) => {
      const { props } = await fixture(state);
      const buy = vi.fn(),
        signIn = vi.fn();
      props.sync.account = { address: "fixture@still.test", confirmed: true };
      props.pro = {
        ownership: "none",
        channel: "ready",
        state: "pending",
        offer: {
          price: "Fixture localized price",
          priceNote: "Fixture offer detail",
        },
        onBuy: buy,
        onSignIn: signIn,
      };
      const view = render(ExtensionSettings, { props });
      const pending = screen.queryByRole("button", {
        name: "Waiting for checkout…",
      });
      if (pending) await fireEvent.click(pending);
      expect(buy).not.toHaveBeenCalled();
      expect(signIn).not.toHaveBeenCalled();
      expect(pending).toBeNull();
      expect(screen.queryByText("Fixture offer detail")).toBeNull();
      expect(screen.queryByText("Checking your Still Pro access…")).toBeNull();
      view.unmount();
    },
  );

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

  it.each(["replacement", "signed-out", "same-address-handler"] as const)(
    "invalidates an account confirmation on %s before any destructive callback",
    async (change) => {
      const { props } = await fixture();
      const first = vi.fn();
      const second = vi.fn();
      props.sync.account = {
        address: "first@fixture.test",
        confirmed: true,
        onDeleteAccount: first,
      };
      const view = render(ExtensionSettings, { props });
      await fireEvent.click(
        screen.getByRole("button", { name: "Delete account" }),
      );
      expect(screen.getByRole("dialog")).toBeVisible();
      if (change === "signed-out") {
        props.sync.account = undefined;
        await view.rerender(props);
      }
      props.sync.account = {
        address:
          change === "same-address-handler"
            ? "first@fixture.test"
            : "second@fixture.test",
        confirmed: true,
        onDeleteAccount: second,
      };
      await view.rerender(props);
      const stale = screen.queryByRole("dialog");
      if (stale)
        await fireEvent.click(
          within(stale).getByRole("button", { name: "Delete account" }),
        );
      expect(first).not.toHaveBeenCalled();
      expect(second).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      await fireEvent.click(
        screen.getByRole("button", { name: "Delete account" }),
      );
      await fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Delete account",
        }),
      );
      expect(second).toHaveBeenCalledOnce();
      expect(first).not.toHaveBeenCalled();
      view.unmount();
    },
  );

  it("keeps the original account handler on an unchanged confirmation and tears down an open modal on unmount", async () => {
    const { props } = await fixture();
    const remove = vi.fn();
    props.sync.account = {
      address: "first@fixture.test",
      confirmed: true,
      onDeleteAccount: remove,
    };
    const view = render(ExtensionSettings, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "Delete account" }),
    );
    await view.rerender({
      ...props,
      sync: { ...props.sync, account: { ...props.sync.account } },
    });
    await fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete account",
      }),
    );
    expect(remove).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: "Delete account" }),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
    view.unmount();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(event.defaultPrevented).toBe(false);
    expect(outside).toHaveFocus();
    expect(remove).toHaveBeenCalledOnce();
    outside.remove();
  });

  it.each(["none", "requested", "verifying"] as const)(
    "keeps the %s sharing switch controlled until the caller reports a changed device choice",
    async (withdrawal) => {
      const change = vi.fn();
      const view = render(SharingCard, {
        props: {
          state: "off",
          withdrawal,
          onChange: change,
          purposesVerified: true,
          purposes: [
            {
              name: "Fixture email plus usage",
              text: "Fixture purpose disclosure.",
            },
          ],
        },
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

  it.each(["missing", "unverified", "empty"] as const)(
    "holds Off-to-On sharing with %s purposes without a callback",
    async (kind) => {
      const change = vi.fn();
      const view = render(SharingCard, {
        props: {
          state: "off",
          onChange: change,
          purposesVerified: kind !== "unverified",
          purposes:
            kind === "missing"
              ? undefined
              : kind === "empty"
                ? []
                : [
                    {
                      name: "Fixture email plus usage",
                      text: "Fixture purpose disclosure.",
                    },
                  ],
        },
      });
      const toggle = screen.getByRole("switch", {
        name: "Share email and usage data",
      });
      await fireEvent.click(toggle);
      expect(change).not.toHaveBeenCalled();
      expect(toggle).toHaveAttribute("aria-checked", "false");
      view.unmount();
    },
  );

  it("discloses verified purposes before Off-to-On, while On-to-Off needs no affirmative disclosure", async () => {
    const change = vi.fn();
    const view = render(SharingCard, {
      props: {
        state: "off",
        purposesVerified: true,
        purposes: [
          {
            name: "Fixture email plus usage",
            text: "Fixture purpose disclosure.",
          },
        ],
        onChange: change,
      },
    });
    expect(screen.getByText("Fixture email plus usage")).toBeVisible();
    expect(screen.getByText("Fixture purpose disclosure.")).toBeVisible();
    const toggle = screen.getByRole("switch", {
      name: "Share email and usage data",
    });
    expect(toggle).toHaveAccessibleDescription(/Fixture purpose disclosure\./);
    await fireEvent.click(toggle);
    expect(change).toHaveBeenCalledExactlyOnceWith(true);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await view.rerender({ state: "on", onChange: change });
    await fireEvent.click(toggle);
    expect(change).toHaveBeenNthCalledWith(2, false);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    view.unmount();
  });

  it("does not turn an acknowledged decline into affirmative consent without purposes", async () => {
    const decline = vi.fn(),
      share = vi.fn(),
      change = vi.fn();
    const view = render(SharingCard, {
      props: { state: "unasked", onDecline: decline, onShare: share },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Don't share" }));
    expect(decline).toHaveBeenCalledOnce();
    await view.rerender({ state: "off", onChange: change });
    await fireEvent.click(
      screen.getByRole("switch", { name: "Share email and usage data" }),
    );
    expect(change).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each(["free", "unsupported", "purchased", "protected"] as const)(
    "never fabricates pending Pro checks from completed %s access",
    async (state) => {
      const { props } = await fixture(state);
      const view = render(ExtensionSettings, { props });
      expect(screen.queryByText("Checking your Still Pro access…")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Get Still Pro" }),
      ).toBeNull();
      expect(screen.getByRole("switch", { name: "Still" })).toBeVisible();
      view.unmount();
    },
  );

  it.each(["verify", "failed"] as const)(
    "preserves explicit %s recovery while access remains held",
    async (ownership) => {
      const { props } = await fixture("verification_required");
      props.pro.ownership = ownership;
      const view = render(ExtensionSettings, { props });
      expect(screen.queryByText("Checking your Still Pro access…")).toBeNull();
      expect(
        screen.getByText(
          ownership === "verify"
            ? "Still Pro needs to be verified again."
            : "We couldn't finish checking. Nothing changed.",
        ),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Get Still Pro" }),
      ).toBeNull();
      view.unmount();
    },
  );

  it("announces checking only from an actual pending access observation", async () => {
    const { props } = await fixture("checking");
    const view = render(ExtensionSettings, { props });
    expect(screen.getByText("Checking your Still Pro access…")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    view.unmount();
  });

  it("shares Explore access rendering and preserves real settings while the service is off", async () => {
    const { props, storage, cache, settled } = await fixture("purchased");
    await cache.setFeature("instagram.explore", true);
    props.settings = requireModernSettings(cache.currentRecord());
    const view = render(ExtensionSettings, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "Instagram Blocker" }),
    );
    const explore = screen.getByRole("switch", {
      name: "Explore recommendations",
    });
    expect(explore).toHaveAccessibleDescription("Search stays.");
    await fireEvent.click(
      screen.getByRole("switch", { name: "Still on Instagram" }),
    );
    await settled();
    props.settings = requireModernSettings(cache.currentRecord());
    await view.rerender(props);
    const saved = await storage.get();
    await fireEvent.click(explore);
    await settled();
    expect(await storage.get()).toEqual(saved);
    expect(props.onFeatureChange).not.toHaveBeenCalled();
    expect(explore).toHaveAttribute("aria-checked", "true");
    props.access = {
      ...props.access,
      states: { ...props.access.states, "instagram.explore": "unsupported" },
    };
    await view.rerender(props);
    const row = screen
      .getByText("Explore recommendations")
      .closest<HTMLElement>(".option-row")!;
    expect(
      within(row).getByText(
        "Not available in this browser. Your choice is saved.",
      ),
    ).toBeVisible();
    expect(within(row).queryByText("Search stays.")).toBeNull();
    view.unmount();
  });

  it("holds both card and locked-row purchase ports for every unavailable current channel, offer, operation or account", async () => {
    const { props } = await fixture("locked");
    const buy = vi.fn(),
      signIn = vi.fn();
    props.sectionMemory = { read: () => "youtube", write: vi.fn() };
    props.pro = {
      ownership: "none",
      channel: "ready",
      offer: { price: "Fixture localized price" },
      onBuy: buy,
      onSignIn: signIn,
    };
    props.sync.account = { address: "fixture@still.test", confirmed: true };
    const view = render(ExtensionSettings, { props });
    const requestBoth = async () => {
      const card = screen.queryByRole("button", { name: "Get Still Pro" });
      if (card) await fireEvent.click(card);
      const pending = screen.queryByRole("button", {
        name: "Waiting for checkout…",
      });
      if (pending) await fireEvent.click(pending);
      expect(
        screen.getByRole("button", {
          name: "Still Pro",
          description: "Comments",
        }),
      ).toBeInTheDocument();
      await requestThroughLock();
    };
    await requestBoth();
    expect(buy).toHaveBeenCalledTimes(2);
    for (const offer of [undefined, { price: "" }, { price: "   " }]) {
      props.pro.offer = offer;
      await view.rerender(props);
      await requestBoth();
      expect(buy).toHaveBeenCalledTimes(2);
    }
    props.pro.offer = { price: "Fixture localized price" };
    for (const channel of ["unverified", "unavailable"] as const) {
      props.pro.channel = channel;
      await view.rerender(props);
      await requestBoth();
      expect(buy).toHaveBeenCalledTimes(2);
    }
    props.pro.channel = "ready";
    for (const state of ["pending", "failed"] as const) {
      props.pro.state = state;
      await view.rerender(props);
      await requestBoth();
      expect(buy).toHaveBeenCalledTimes(2);
    }
    props.pro.state = "idle";
    for (const state of ["checking", "verify", "failed"] as const) {
      props.restore = { state };
      await view.rerender(props);
      await requestBoth();
      expect(buy).toHaveBeenCalledTimes(2);
    }
    props.restore = undefined;
    props.sync.account.confirmed = false;
    await view.rerender(props);
    await requestBoth();
    expect(buy).toHaveBeenCalledTimes(2);
    expect(signIn).toHaveBeenCalledTimes(2);
    props.pro.onSignIn = undefined;
    await view.rerender(props);
    await requestBoth();
    expect(signIn).toHaveBeenCalledTimes(2);
    props.sync.account.confirmed = true;
    props.pro.onBuy = undefined;
    await view.rerender(props);
    await requestBoth();
    expect(buy).toHaveBeenCalledTimes(2);
    props.pro.onBuy = buy;
    await view.rerender(props);
    await requestBoth();
    expect(buy).toHaveBeenCalledTimes(4);
    view.unmount();
  });
});
