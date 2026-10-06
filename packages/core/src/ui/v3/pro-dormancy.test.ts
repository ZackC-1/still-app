// Owner decision 24: while the paid tier is off, the 12 Still Pro rows show the existing locked
// design (a lock and "Still Pro"), never the unsupported note, and tapping one never offers a
// purchase, a price, a paywall or the app hand-off. These tests render every host's component with
// the PACKAGED access snapshot (paid off, so every Pro feature is `unsupported`) and with every
// purchase port a host could supply, then tap each lock.
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import {
  DEFAULT_SETTINGS,
  FEATURE_REGISTRY,
  PAID_TIER_ENABLED,
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
} from "../../entitlement/access-policy.js";
import { proRowsDormant } from "./presentation.js";
import DesktopPopup from "./DesktopPopup.svelte";
import MobilePopup from "./MobilePopup.svelte";
import ExtensionSettings from "./ExtensionSettings.svelte";
import AppleSettings from "./AppleSettings.svelte";
import FeatureRow from "./FeatureRow.svelte";
import { fixture as desktopFixture } from "./DesktopPopup.fixtures.js";
import { fixture as optionsFixture } from "./ExtensionSettings.test-fixtures.js";
import type { MobilePopupProps } from "./mobile-presentation.js";
import type { AppleSettingsProps } from "./apple-settings-presentation.js";

const PRO = FEATURE_REGISTRY.filter((row) => row.tier === "pro");
const SERVICES = ["youtube", "instagram", "facebook"] as const;
const TITLES = {
  youtube: "YouTube Blocker",
  instagram: "Instagram Blocker",
  facebook: "Facebook Blocker",
} as const;
/** Anything that would be a purchase, price, paywall or app hand-off on any host. */
const OFFER =
  /Purchase Still Pro|Get Still Pro|See Still Pro in the Still app|Buy|Fixture localized price|Payment is handled|Sign in to buy/;

async function savedCache() {
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
  // A saved On for every Pro feature: the strongest case for leaking an effect or an offer.
  for (const row of PRO) await cache.setFeature(row.id, true);
  return { storage, cache };
}

/** Decision 40: every lock is named exactly "Still Pro"; its row's label describes it. */
const describedBy = (feature: string) =>
  new RegExp(`^${feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`);

/** Opens each section and taps every Pro row's lock; returns the number of locks tapped. */
async function tapEveryLock(expected: readonly FeatureId[]) {
  let tapped = 0;
  for (const service of SERVICES.filter((id) =>
    PRO.some((row) => row.service === id && expected.includes(row.id)),
  )) {
    const expander = screen.getByRole("button", { name: TITLES[service] });
    if (expander.getAttribute("aria-expanded") !== "true")
      await fireEvent.click(expander);
    const panel = screen.getByRole("group", { name: TITLES[service] });
    for (const row of PRO.filter(
      (feature) => feature.service === service && expected.includes(feature.id),
    )) {
      const rowElement = within(panel)
        .getByText(row.name)
        .closest(".option-row") as HTMLElement;
      expect(rowElement, row.id).toHaveAttribute("data-access", "locked");
      expect(within(rowElement).queryByRole("switch"), row.id).toBeNull();
      expect(
        within(rowElement).queryByText(/Not available/),
        row.id,
      ).toBeNull();
      expect(within(rowElement).getByText("Still Pro"), row.id).toBeVisible();
      const lock = within(rowElement).getByRole("button", {
        name: "Still Pro",
      });
      expect(lock, row.id).toHaveAccessibleDescription(describedBy(row.name));
      expect(lock, row.id).toHaveAttribute("aria-disabled", "true");
      await fireEvent.click(lock);
      tapped++;
    }
  }
  expect(screen.queryByText(OFFER)).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  return tapped;
}

describe("decision 24: dormant Still Pro rows", () => {
  it("the shipped paid flag is off and the packaged snapshot is the dormant one", () => {
    expect(PAID_TIER_ENABLED).toBe(false);
    const packaged = initialAccessSnapshot();
    for (const row of PRO) expect(packaged.states[row.id]).toBe("unsupported");
    expect(proRowsDormant(packaged)).toBe(true);
  });

  it("is dormant only while paid is off and every Pro feature is unsupported", () => {
    const packaged = initialAccessSnapshot();
    expect(proRowsDormant(packaged, true)).toBe(false);
    // A paid-world snapshot with one host-unsupported feature keeps the honest unsupported note.
    for (const state of [
      "locked",
      "purchased",
      "protected",
      "checking",
      "verification_required",
      "free",
    ] as const) {
      const mixed = {
        ...packaged,
        states: { ...packaged.states, "youtube.comments": state },
      };
      expect(proRowsDormant(mixed), state).toBe(false);
    }
    // Free rows never decide dormancy.
    const freeHeld = {
      ...packaged,
      states: { ...packaged.states, "youtube.shorts": "unsupported" as const },
    };
    expect(proRowsDormant(freeHeld)).toBe(true);
  });

  it("a dormant row ignores a supplied lock action and never renders a switch", async () => {
    const onLock = vi.fn();
    const onChange = vi.fn();
    const view = render(FeatureRow, {
      props: {
        id: "youtube.comments",
        label: "Comments",
        state: "unsupported",
        dormant: true,
        checked: true,
        inactive: false,
        unsupportedText: "Not available in this browser. Your choice is saved.",
        onChange,
        onLock,
      },
    });
    const lock = screen.getByRole("button", { name: "Still Pro" });
    expect(lock).toHaveAccessibleDescription("Comments");
    expect(lock).toHaveAttribute("aria-disabled", "true");
    await fireEvent.click(lock);
    expect(onLock).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(/Not available/)).toBeNull();
    view.unmount();
  });

  it.each(["Chrome", "Firefox"] as const)(
    "%s desktop popup: 12 locked inert rows and no purchase even with a purchase port",
    async (browser) => {
      const { storage, cache } = await savedCache();
      const { props } = await desktopFixture();
      props.browser = browser;
      props.settings = requireModernSettings(cache.currentRecord());
      props.access = initialAccessSnapshot();
      props.onPurchase = vi.fn();
      const saved = await storage.get();
      const view = render(DesktopPopup, { props });
      // Each section mounts its rows only while open, so tap one section at a time.
      let tapped = 0;
      for (const service of SERVICES) {
        tapped += await tapEveryLock(
          PRO.filter((row) => row.service === service).map((row) => row.id),
        );
      }
      expect(tapped).toBe(12);
      expect(props.onPurchase).not.toHaveBeenCalled();
      expect(props.onFeatureChange).not.toHaveBeenCalled();
      expect(await storage.get()).toEqual(saved);
      view.unmount();
    },
  );

  it.each(["safari", "firefox"] as const)(
    "%s mobile popup: 11 locked inert rows and no app hand-off or purchase even with every port",
    async (host) => {
      const { storage, cache } = await savedCache();
      const props: MobilePopupProps = {
        settings: requireModernSettings(cache.currentRecord()),
        access: initialAccessSnapshot(),
        host,
        channelReady: true,
        onSeePro: vi.fn(),
        onPurchase: vi.fn(),
        privacyUrl: "https://still.test/privacy",
        onGlobalChange: vi.fn(),
        onServiceChange: vi.fn(),
        onFeatureChange: vi.fn(),
        onSettings: vi.fn(),
        onSignIn: vi.fn(),
      };
      const saved = await storage.get();
      const view = render(MobilePopup, { props });
      const mobile = PRO.filter((row) => row.id !== "facebook.sponsored").map(
        (row) => row.id,
      );
      expect(await tapEveryLock(mobile)).toBe(11);
      expect(screen.queryByText("Desktop sidebar ads")).toBeNull();
      expect(props.onSeePro).not.toHaveBeenCalled();
      expect(props.onPurchase).not.toHaveBeenCalled();
      expect(await storage.get()).toEqual(saved);
      view.unmount();
    },
  );

  it("extension settings (Chrome, Firefox, Safari options): 12 locked inert rows even with a ready offer", async () => {
    const { cache } = await savedCache();
    const { props, storage } = await optionsFixture();
    const buy = vi.fn();
    const signIn = vi.fn();
    props.settings = requireModernSettings(cache.currentRecord());
    props.access = initialAccessSnapshot();
    props.pro = {
      ownership: "none",
      channel: "ready",
      offer: { price: "Fixture localized price" },
      onBuy: buy,
      onSignIn: signIn,
    };
    props.sync.account = { address: "fixture@still.test", confirmed: true };
    const saved = await storage.get();
    const view = render(ExtensionSettings, { props });
    expect(await tapEveryLock(PRO.map((row) => row.id))).toBe(12);
    expect(buy).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(props.onFeatureChange).not.toHaveBeenCalled();
    expect(await storage.get()).toEqual(saved);
    view.unmount();
  });

  it.each(["ios", "mac"] as const)(
    "Apple D04 settings (%s): locked inert rows, only the free-period Restore link, never Buy or a price",
    async (platform) => {
      const { storage, cache } = await savedCache();
      const onRestore = vi.fn();
      // The shipped Apple host supplies no paid producer while paid is off (decisions 7 and 17).
      const props: AppleSettingsProps = {
        platform,
        settings: requireModernSettings(cache.currentRecord()),
        access: initialAccessSnapshot(),
        onGlobalChange: vi.fn(),
        onServiceChange: vi.fn(),
        onFeatureChange: vi.fn(),
        sync: { onSignIn: vi.fn() },
        onRestore,
        help: { onGuide: vi.fn(), onSupport: vi.fn(), onPrivacy: vi.fn() },
      };
      const saved = await storage.get();
      const view = render(AppleSettings, { props });
      const rows = PRO.filter(
        (row) => platform === "mac" || row.id !== "facebook.sponsored",
      ).map((row) => row.id);
      expect(await tapEveryLock(rows)).toBe(rows.length);
      expect(onRestore).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "Restore purchase" }),
      ).toBeVisible();
      expect(props.onFeatureChange).not.toHaveBeenCalled();
      expect(await storage.get()).toEqual(saved);
      view.unmount();
    },
  );

  it("Apple D04 settings: a supplied ready Buy port is still never reached from a locked row", async () => {
    const { cache } = await savedCache();
    const onBuy = vi.fn();
    const props: AppleSettingsProps = {
      platform: "mac",
      settings: requireModernSettings(cache.currentRecord()),
      access: initialAccessSnapshot(),
      onGlobalChange: vi.fn(),
      onServiceChange: vi.fn(),
      onFeatureChange: vi.fn(),
      sync: { onSignIn: vi.fn() },
      pro: {
        ownership: "none",
        channel: "ready",
        offer: { price: "Fixture localized price" },
        onBuy,
      },
      help: { onGuide: vi.fn(), onSupport: vi.fn(), onPrivacy: vi.fn() },
    };
    const view = render(AppleSettings, { props });
    for (const service of SERVICES)
      await fireEvent.click(
        screen.getByRole("button", { name: TITLES[service] }),
      );
    for (const row of PRO) {
      const lock = screen.getByRole("button", {
        name: "Still Pro",
        description: describedBy(row.name),
      });
      expect(lock).toHaveAttribute("aria-disabled", "true");
      await fireEvent.click(lock);
    }
    expect(onBuy).not.toHaveBeenCalled();
    view.unmount();
  });

  it("the same components still render a paid-world locked row as an offer port (the gate is dormancy, not the design)", async () => {
    // Control: an injected paid-world snapshot (some Pro feature `locked`) is not dormant, so a
    // supplied purchase port stays reachable: the lock opens the paywall sheet (decision 41) and
    // its explicit Purchase button is the only way to the port.
    const { props } = await desktopFixture();
    props.access = {
      ...props.access,
      states: Object.fromEntries(
        ACCESS_BENEFITS.map((id) => [
          id,
          PRO.some((row) => row.id === id) ? "locked" : "free",
        ]),
      ) as typeof props.access.states,
    };
    props.onPurchase = vi.fn();
    const view = render(DesktopPopup, { props });
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Still Pro",
        description: "Comments",
      }),
    );
    const sheet = screen.getByRole("dialog", { name: "Still Pro" });
    expect(props.onPurchase).not.toHaveBeenCalled();
    await fireEvent.click(
      within(sheet).getByRole("button", { name: "Purchase Still Pro" }),
    );
    expect(props.onPurchase).toHaveBeenCalledOnce();
    view.unmount();
  });
});
