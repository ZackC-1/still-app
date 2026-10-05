import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import {
  fixture,
  retainedConfirmationPorts,
} from "./ExtensionSettings.test-fixtures.js";
import ExtensionSettings from "./ExtensionSettings.svelte";

describe("options host leaf contracts", () => {
  it("holds current global, service and free feature callbacks while preserving saved choices and focus", async () => {
    const { props, storage } = await fixture("free");
    props.sectionMemory = { read: () => "youtube", write: vi.fn() };
    const view = render(ExtensionSettings, { props });
    const global = screen.getByRole("switch", { name: "Still" });
    const service = screen.getByRole("switch", { name: "Still on YouTube" });
    const shorts = screen.getByRole("switch", { name: "Shorts" });
    const saved = await storage.get();
    await view.rerender({ ...props, commandsDisabled: true });
    for (const toggle of [global, service, shorts]) {
      toggle.focus();
      expect(toggle).toHaveFocus();
      expect(toggle).not.toHaveAttribute("disabled");
      await fireEvent.click(toggle);
    }
    expect(props.onGlobalChange).not.toHaveBeenCalled();
    expect(props.onServiceChange).not.toHaveBeenCalled();
    expect(props.onFeatureChange).not.toHaveBeenCalled();
    for (const toggle of [global, service, shorts]) {
      expect(toggle).toHaveAttribute("aria-disabled", "true");
      expect(toggle).toHaveAttribute("aria-checked", "true");
    }
    expect(await storage.get()).toEqual(saved);
    await fireEvent.click(
      screen.getByRole("button", { name: "Facebook Blocker" }),
    );
    expect(props.sectionMemory.write).toHaveBeenCalledWith("facebook");
    expect(document.querySelectorAll(".service-options.open")).toHaveLength(1);
    await view.rerender({ ...props, commandsDisabled: false });
    await fireEvent.click(global);
    expect(props.onGlobalChange).toHaveBeenCalledExactlyOnceWith(false);
    view.unmount();
  });

  it("retains real signed-in status and account actions without an email address", async () => {
    const { props } = await fixture("free");
    const signOut = vi.fn(),
      remove = vi.fn(),
      retry = vi.fn();
    props.sync.account = {
      confirmed: true,
      identity: "actual-account-A",
      revision: 1,
      onSignOut: signOut,
      onDeleteAccount: remove,
      status: {
        tone: "failed",
        text: "Sync did not finish.",
        actionLabel: "Try again",
        onAction: retry,
      },
    };
    const view = render(ExtensionSettings, { props });
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(
      screen.queryByText(
        "Free. Keep your settings updated across every supported surface",
      ),
    ).toBeNull();
    expect(screen.getByText("Sync did not finish.")).toBeVisible();
    expect(document.querySelector(".synced")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(signOut).toHaveBeenCalledOnce();
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

  it.each(["identity", "revision", "ABA"] as const)(
    "invalidates a same-address, same-handler deletion target after actual %s replacement",
    async (change) => {
      const { props } = await fixture("free");
      const remove = vi.fn();
      const account = {
        address: "same@fixture.test",
        confirmed: true,
        identity: "account-A",
        revision: 1,
        onDeleteAccount: remove,
      };
      props.sync.account = account;
      const view = render(ExtensionSettings, { props });
      await fireEvent.click(
        screen.getByRole("button", { name: "Delete account" }),
      );
      expect(screen.getByRole("dialog")).toBeVisible();
      const next =
        change === "identity"
          ? { ...account, identity: "account-B" }
          : { ...account, revision: 2 };
      await view.rerender({ ...props, sync: { ...props.sync, account: next } });
      if (change === "ABA")
        await view.rerender({
          ...props,
          sync: { ...props.sync, account: { ...account, revision: 3 } },
        });
      const stale = screen.queryByRole("dialog");
      if (stale)
        await fireEvent.click(
          within(stale).getByRole("button", { name: "Delete account" }),
        );
      expect(remove).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
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
    },
  );

  it("omits absent combined-consent and paid producers without fabricating a panel or callback", async () => {
    const { props } = await fixture("locked");
    const view = render(ExtensionSettings, {
      props: { ...props, sharing: undefined, pro: undefined },
    });
    expect(
      screen.queryByText("Share your email and usage data with Still?"),
    ).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Share email and usage data" }),
    ).toBeNull();
    expect(
      screen.queryByText("Still Pro can't be bought here yet."),
    ).toBeNull();
    expect(screen.queryByText("Checking your Still Pro access…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    expect(screen.getByText("Settings sync")).toBeVisible();
    expect(screen.queryByText("Still Pro and sync")).toBeNull();
    expect(screen.getByRole("switch", { name: "Still" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Privacy policy" }),
    ).toBeVisible();
    view.unmount();
  });
});

describe("caller supplied privacy action slot", () => {
  it("keeps supplied privacy actions operational without representing them as combined consent", async () => {
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
    const view = render(ExtensionSettings, {
      props: { ...props, sharing: undefined, pro: undefined, privacyActions },
    });
    await fireEvent.click(
      screen.getByRole("button", { name: "Keep legacy usage sharing off" }),
    );
    expect(optOut).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("switch", { name: "Share email and usage data" }),
    ).toBeNull();
    await view.rerender({ ...props, privacyActions });
    expect(
      screen.getByRole("switch", { name: "Share email and usage data" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Keep legacy usage sharing off" }),
    ).toBeNull();
    view.unmount();
  });
});

describe("actual caller sync-card action slot", () => {
  it.each([false, true])(
    "keeps the real recovery action inside the one sync card when signed-in=%s",
    async (signedIn) => {
      const { createRawSnippet } = await import("svelte");
      const retry = vi.fn();
      const accountActions = createRawSnippet(() => ({
        render: () =>
          '<button type="button">Read actual saved settings again</button>',
        setup: (node) => {
          node.addEventListener("click", retry);
          return () => node.removeEventListener("click", retry);
        },
      }));
      const { props } = await fixture("free");
      const view = render(ExtensionSettings, {
        props: {
          ...props,
          pro: undefined,
          sharing: undefined,
          sync: {
            account: signedIn
              ? { identity: "synthetic-current", confirmed: false }
              : undefined,
            accountActions,
          },
        },
      });
      const action = screen.getByRole("button", {
        name: "Read actual saved settings again",
      });
      expect(
        within(action.closest("section")!).getByRole("heading", {
          name: "Settings sync",
        }),
      ).toBeTruthy();
      expect(
        screen.getAllByRole("heading", { name: "Settings sync" }),
      ).toHaveLength(1);
      await fireEvent.click(action);
      expect(retry).toHaveBeenCalledOnce();
      view.unmount();
    },
  );
});

describe("exact mounted deletion dialog lifetime", () => {
  it.each(["replacement", "same-account reopen", "unmount"] as const)(
    "rejects retained confirmation after %s without consuming a newer dialog",
    async (change) => {
      retainedConfirmationPorts.length = 0;
      const { props } = await fixture();
      const removeA = vi.fn();
      const removeB = vi.fn();
      props.sync.account = {
        identity: "account-a",
        revision: 1,
        confirmed: false,
        onDeleteAccount: removeA,
      };
      const view = render(ExtensionSettings, { props });
      await fireEvent.click(
        screen.getByRole("button", { name: "Delete account" }),
      );
      const stale = retainedConfirmationPorts.at(-1);
      expect(stale).toBeTypeOf("function");
      if (change === "unmount") {
        view.unmount();
        stale!();
        expect(removeA).not.toHaveBeenCalled();
        return;
      }
      await fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Cancel",
        }),
      );
      if (change === "replacement")
        await view.rerender({
          sync: {
            account: {
              identity: "account-b",
              revision: 2,
              confirmed: false,
              onDeleteAccount: removeB,
            },
          },
        });
      await fireEvent.click(
        screen.getByRole("button", { name: "Delete account" }),
      );
      stale!();
      await import("svelte").then(({ tick }) => tick());
      expect(removeA).not.toHaveBeenCalled();
      expect(removeB).not.toHaveBeenCalled();
      const dialog = screen.getByRole("dialog");
      await fireEvent.click(
        within(dialog).getByRole("button", { name: "Delete account" }),
      );
      expect(
        change === "replacement" ? removeB : removeA,
      ).toHaveBeenCalledOnce();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );
});
