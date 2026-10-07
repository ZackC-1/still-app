import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
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
  mount(): Promise<{
    buy: ReturnType<typeof vi.fn>;
    navigate?: ReturnType<typeof vi.fn>;
    unmount: () => void;
  }>;
  /** Settings retain a separate explicit purchase button. */
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
      const navigate = vi.fn();
      props.onPurchase = buy;
      props.onSeePro = navigate;
      return {
        buy,
        navigate,
        unmount: await show(render(DesktopPopup, { props })),
      };
    },
  },
  {
    name: "Firefox for Android popup",
    buyLabel: "Purchase Still Pro",
    async mount() {
      const { props: desktop } = await desktopFixture("locked");
      const buy = vi.fn();
      const navigate = vi.fn();
      const props: MobilePopupProps = {
        settings: desktop.settings,
        access: desktop.access,
        host: "firefox",
        channelReady: true,
        onPurchase: buy,
        onSeePro: navigate,
        privacyUrl: "https://still.test/privacy",
        onGlobalChange: vi.fn(),
        onServiceChange: vi.fn(),
        onFeatureChange: vi.fn(),
        onSettings: vi.fn(),
        onSignIn: vi.fn(),
      };
      return {
        buy,
        navigate,
        unmount: await show(render(MobilePopup, { props })),
      };
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
  screen.getByRole("button", {
    name: "Comments. Included in Still Pro. See Still Pro",
  });

describe.each(HOSTS)("latest reference Pro destination: $name", (host) => {
  it("opens the host destination or existing Pro region without an intermediate sheet", async () => {
    const { buy, navigate, unmount } = await host.mount();
    await fireEvent.click(lock());
    expect(screen.queryByRole("dialog")).toBeNull();
    if (host.buyLabel === "Purchase Still Pro") {
      expect(navigate).toHaveBeenCalledOnce();
      expect(buy).not.toHaveBeenCalled();
      await fireEvent.click(
        screen.getByRole("button", { name: host.buyLabel }),
      );
      expect(buy).toHaveBeenCalledOnce();
    } else {
      const card = screen.getByRole("region", { name: "Still Pro" });
      expect(card).toHaveFocus();
      expect(buy).not.toHaveBeenCalled();
      await fireEvent.click(
        within(card).getByRole("button", { name: host.buyLabel }),
      );
      expect(buy).toHaveBeenCalledOnce();
    }
    unmount();
  });
});

describe("packaged free-period access stays dormant", () => {
  it.each(["Chrome", "Firefox"] as const)(
    "%s holds the destination even with a supplied port",
    async (browser) => {
      const { props } = await desktopFixture();
      props.browser = browser;
      props.access = initialAccessSnapshot();
      props.onPurchase = vi.fn();
      props.onSeePro = vi.fn();
      const unmount = await show(render(DesktopPopup, { props }));
      const opener = screen.getByRole("button", {
        name: "Comments. Included in Still Pro.",
      });
      expect(opener).toHaveAttribute("aria-disabled", "true");
      await fireEvent.click(opener);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(props.onPurchase).not.toHaveBeenCalled();
      expect(props.onSeePro).not.toHaveBeenCalled();
      unmount();
    },
  );
});
