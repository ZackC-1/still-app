// Owner decisions 40 and 41, paid ON (a test-only seam: an injected paid-world access snapshot in
// which the Still Pro features are `locked`, plus a ready offer port). A locked row's lock opens the
// Still Pro sheet holding that host's existing offer. The sheet closes with its X, with Escape and
// with a click outside it, and focus returns to the lock that opened it. Opening it starts
// nothing: only the sheet's explicit Buy reaches the purchase port. With paid OFF the same rows
// stay inert (pro-dormancy.test.ts).
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { FEATURE_REGISTRY } from "@still/shared-types";
import { initialAccessSnapshot } from "../../entitlement/access-policy.js";
import DesktopPopup from "./DesktopPopup.svelte";
import MobilePopup from "./MobilePopup.svelte";
import ExtensionSettings from "./ExtensionSettings.svelte";
import AppleSettings from "./AppleSettings.svelte";
import { fixture as desktopFixture } from "./DesktopPopup.fixtures.js";
import { fixture as optionsFixture } from "./ExtensionSettings.test-fixtures.js";
import type { MobilePopupProps } from "./mobile-presentation.js";
import type { AppleSettingsProps } from "./apple-settings-presentation.js";

interface Host {
  name: string;
  /** Renders the host in the paid world; `buy` is the only purchase port it may reach. */
  mount(): Promise<{ buy: ReturnType<typeof vi.fn>; unmount: () => void }>;
  /** The sheet's explicit purchase button. */
  buyLabel: string;
}

function lockedAccess() {
  const access = initialAccessSnapshot();
  const states = { ...access.states };
  for (const row of FEATURE_REGISTRY)
    states[row.id] = row.tier === "pro" ? "locked" : "free";
  return { ...access, states };
}

async function show(view: { unmount: () => void }) {
  const youtube = screen.getByRole("button", { name: "YouTube Blocker" });
  if (youtube.getAttribute("aria-expanded") !== "true")
    await fireEvent.click(youtube);
  return () => view.unmount();
}

const HOSTS: Host[] = [
  {
    name: "Chrome desktop popup",
    buyLabel: "Purchase Still Pro",
    async mount() {
      const { props } = await desktopFixture("locked");
      const buy = vi.fn();
      props.onPurchase = buy;
      return { buy, unmount: await show(render(DesktopPopup, { props })) };
    },
  },
  {
    name: "Firefox for Android popup",
    buyLabel: "Purchase Still Pro",
    async mount() {
      const { props: desktop } = await desktopFixture("locked");
      const buy = vi.fn();
      const props: MobilePopupProps = {
        settings: desktop.settings,
        access: desktop.access,
        host: "firefox",
        channelReady: true,
        onPurchase: buy,
        privacyUrl: "https://still.test/privacy",
        onGlobalChange: vi.fn(),
        onServiceChange: vi.fn(),
        onFeatureChange: vi.fn(),
        onSettings: vi.fn(),
        onSignIn: vi.fn(),
      };
      return { buy, unmount: await show(render(MobilePopup, { props })) };
    },
  },
  {
    name: "extension settings",
    buyLabel: "Get Still Pro",
    async mount() {
      const { props } = await optionsFixture("locked");
      const buy = vi.fn();
      props.sync.account = { address: "fixture@still.test", confirmed: true };
      props.pro = {
        ownership: "none",
        channel: "ready",
        offer: { price: "Fixture localized price" },
        onBuy: buy,
        onSignIn: vi.fn(),
      };
      return { buy, unmount: await show(render(ExtensionSettings, { props })) };
    },
  },
  {
    name: "Apple settings",
    buyLabel: "Get Still Pro",
    async mount() {
      const { props: desktop } = await desktopFixture("locked");
      const buy = vi.fn();
      const props: AppleSettingsProps = {
        platform: "ios",
        settings: desktop.settings,
        access: lockedAccess(),
        onGlobalChange: vi.fn(),
        onServiceChange: vi.fn(),
        onFeatureChange: vi.fn(),
        sync: { onSignIn: vi.fn() },
        pro: {
          ownership: "none",
          channel: "ready",
          offer: { price: "Fixture localized price" },
          onBuy: buy,
        },
        help: { onGuide: vi.fn(), onSupport: vi.fn(), onPrivacy: vi.fn() },
      };
      return { buy, unmount: await show(render(AppleSettings, { props })) };
    },
  },
];

const lock = () =>
  screen.getByRole("button", { name: "Still Pro", description: "Comments" });
const sheet = () => screen.queryByRole("dialog", { name: "Still Pro" });

async function open() {
  const opener = lock();
  opener.focus();
  await fireEvent.click(opener);
  await tick();
  const dialog = sheet();
  expect(dialog).not.toBeNull();
  return { opener, dialog: dialog! };
}

describe.each(HOSTS)("decision 41, paid on: $name", (host) => {
  it("a locked row opens the Still Pro sheet without starting a purchase; X, Escape and outside close it and return focus", async () => {
    const { buy, unmount } = await host.mount();
    expect(sheet()).toBeNull();

    // X.
    const first = await open();
    let opener = first.opener;
    const dialog = first.dialog;
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(buy).not.toHaveBeenCalled();
    const close = within(dialog).getByRole("button", { name: "Close" });
    // The X takes focus first, so a stray Enter after an accidental tap only closes.
    expect(close).toHaveFocus();
    await fireEvent.click(close);
    await tick();
    expect(sheet()).toBeNull();
    expect(opener).toHaveFocus();

    // Escape.
    ({ opener } = await open());
    await fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await tick();
    expect(sheet()).toBeNull();
    expect(opener).toHaveFocus();

    // A tap or click outside the sheet.
    ({ opener } = await open());
    await fireEvent.click(document.querySelector<HTMLElement>(".scrim")!);
    await tick();
    expect(sheet()).toBeNull();
    expect(opener).toHaveFocus();

    expect(buy).not.toHaveBeenCalled();
    unmount();
  });

  it("only the sheet's explicit Buy reaches the purchase port, once per press", async () => {
    const { buy, unmount } = await host.mount();
    const { dialog } = await open();
    expect(buy).not.toHaveBeenCalled();
    // Tab stays inside the sheet.
    const controls = within(dialog).getAllByRole("button");
    controls.at(-1)!.focus();
    await fireEvent.keyDown(controls.at(-1)!, { key: "Tab" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await fireEvent.click(
      within(dialog).getByRole("button", { name: host.buyLabel }),
    );
    expect(buy).toHaveBeenCalledOnce();
    unmount();
  });
});

describe("decision 41, paid off: the same hosts never open the sheet", () => {
  it.each(["Chrome", "Firefox"] as const)(
    "%s desktop popup with the packaged snapshot and a purchase port",
    async (browser) => {
      const { props } = await desktopFixture();
      props.browser = browser;
      props.access = initialAccessSnapshot();
      props.onPurchase = vi.fn();
      const unmount = await show(render(DesktopPopup, { props }));
      const opener = lock();
      expect(opener).toHaveAttribute("aria-disabled", "true");
      await fireEvent.click(opener);
      await tick();
      expect(sheet()).toBeNull();
      expect(props.onPurchase).not.toHaveBeenCalled();
      unmount();
    },
  );
});
