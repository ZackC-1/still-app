// ISS-0122 (owner ruling, 22 Oct): when Still Pro is not owned, a locked row shows NO switch, only
// the row's name and the Still Pro chip, on every surface. This supersedes CH-96 option C (a dimmed
// saved switch beside the lock after a refund). Saved choices stay in storage untouched and apply
// again when Still Pro returns.
//
// One host matrix, shared by locked-row-no-switch.test.ts (paid tier off: dormant rows) and
// locked-row-no-switch.paid-on.test.ts (paid tier on: locked rows with a destination), so both
// worlds assert the same rule on every host that draws feature rows: DesktopPopup (Chrome, Firefox
// and Mac Safari popups), MobilePopup (iPhone Safari popup), SettingsSiteList through
// ExtensionSettings (Chrome/Firefox Settings) and AppleSettings (the iPhone and Mac app).
import { fireEvent, render, screen } from "@testing-library/svelte";
import { expect, vi } from "vitest";
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
import DesktopPopup from "./DesktopPopup.svelte";
import MobilePopup from "./MobilePopup.svelte";
import ExtensionSettings from "./ExtensionSettings.svelte";
import AppleSettings from "./AppleSettings.svelte";

export const LOCKED_ROW_HOSTS = [
  "Chrome popup (DesktopPopup)",
  "Mac Safari popup (DesktopPopup)",
  "iPhone Safari popup (MobilePopup)",
  "Chrome Settings (ExtensionSettings)",
  "iPhone app (AppleSettings)",
  "Mac app (AppleSettings)",
] as const;
export type LockedRowHost = (typeof LOCKED_ROW_HOSTS)[number];

/** Every Pro row is set ON in storage first, so a locked row has a saved choice it could show. */
export async function lockedFixture(state: AccessState = "locked") {
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
  for (const row of FEATURE_REGISTRY)
    if (row.tier === "pro") await cache.setFeature(row.id, true);
  const access = initialAccessSnapshot({ paidMode: false, supported: new Set(ACCESS_BENEFITS) });
  const states = { ...access.states };
  for (const row of FEATURE_REGISTRY) if (row.tier === "pro") states[row.id] = state;
  const onFeatureChange = vi.fn((id: FeatureId, next: boolean) => void cache.setFeature(id, next));
  const onServiceChange = vi.fn((id: ServiceId, next: boolean) => void cache.setService(id, next));
  const onGlobalChange = vi.fn((next: boolean) => void cache.setGlobalOn(next));
  return {
    storage,
    cache,
    settings: requireModernSettings(cache.currentRecord()),
    access: { ...access, states },
    accessFor: (next: AccessState) => {
      const changed = { ...access.states };
      for (const row of FEATURE_REGISTRY) if (row.tier === "pro") changed[row.id] = next;
      return { ...access, states: changed };
    },
    onFeatureChange,
    onServiceChange,
    onGlobalChange,
  };
}

type Fixture = Awaited<ReturnType<typeof lockedFixture>>;

/** The rendered host, as far as the cases use it. */
export interface LockedHostView {
  rerender(props: Record<string, unknown>): Promise<void>;
}

/** Renders one host, signed out or signed in, with every Pro row in `fixture.access`. */
export function renderLockedHost(host: LockedRowHost, fixture: Fixture, signedIn: boolean): LockedHostView {
  const seePro = vi.fn();
  const common = {
    settings: fixture.settings,
    access: fixture.access,
    onGlobalChange: fixture.onGlobalChange,
    onServiceChange: fixture.onServiceChange,
    onFeatureChange: fixture.onFeatureChange,
  };
  const popupAccount = signedIn ? { account: { address: "person@still.test" } } : {};
  const settingsSync = {
    onSignIn: vi.fn(),
    ...(signedIn ? { account: { address: "person@still.test", confirmed: true } } : {}),
  };
  const popup = {
    ...common,
    ...popupAccount,
    privacyUrl: "https://still.test/privacy",
    onSignIn: vi.fn(),
    onSettings: vi.fn(),
    onSeePro: seePro,
  };
  switch (host) {
    case "Chrome popup (DesktopPopup)":
      return render(DesktopPopup, { props: { ...popup, browser: "Chrome" } });
    case "Mac Safari popup (DesktopPopup)":
      return render(DesktopPopup, { props: { ...popup, browser: "Chrome", appHandoff: true } });
    case "iPhone Safari popup (MobilePopup)":
      return render(MobilePopup, { props: { ...popup, host: "safari", appHandoff: true } });
    case "Chrome Settings (ExtensionSettings)":
      return render(ExtensionSettings, {
          props: {
            ...common,
            sync: settingsSync,
            pro: { ownership: "none", channel: "unverified" },
            help: { onGuide: vi.fn(), onSupport: vi.fn(), onPrivacy: vi.fn() },
          },
        });
    case "iPhone app (AppleSettings)":
    case "Mac app (AppleSettings)":
      return render(AppleSettings, {
          props: {
            ...common,
            platform: host === "Mac app (AppleSettings)" ? "mac" : "ios",
            sync: settingsSync,
            pro: { ownership: "none", channel: "unverified" },
            help: { onGuide: vi.fn(), onSafariSetup: vi.fn(), onSupport: vi.fn(), onPrivacy: vi.fn() },
          },
        });
  }
}

/** Opens each site in turn (the popups draw only the open site's rows) and visits its rows. */
export async function eachOpenSite(visit: (panel: HTMLElement) => void | Promise<void>) {
  for (const site of ["Instagram", "Facebook", "YouTube"]) {
    const expander = screen.getByRole("button", { name: `${site} Blocker` });
    if (expander.getAttribute("aria-expanded") !== "true") await fireEvent.click(expander);
    await visit(screen.getByRole("group", { name: `${site} Blocker` }));
  }
}

/**
 * The ISS-0122 rule for one locked row: no switch of any kind, exactly one Still Pro chip whose
 * accessible name starts "<name>. Included in Still Pro.", and every id the row's controls point
 * at (aria-labelledby, aria-describedby) exists, so nothing is left orphaned by the removed switch.
 */
export function expectLockedRowWithoutSwitch(row: HTMLElement) {
  const name = row.querySelector(".label")?.textContent?.trim() ?? "";
  expect(name, "the row keeps its visible name").not.toBe("");
  expect(row.querySelectorAll('[role="switch"], input[type="checkbox"]'), `${name}: no switch`).toHaveLength(0);
  const chips = row.querySelectorAll<HTMLElement>("button.lock-pro");
  expect(chips, `${name}: one Still Pro chip`).toHaveLength(1);
  const chip = chips[0]!;
  expect(chip.textContent?.trim()).toBe("Still Pro");
  expect(chip.getAttribute("aria-label")).toMatch(
    new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Included in Still Pro\\.( (See Still Pro|Open the Still app))?$`),
  );
  for (const element of [row, ...row.querySelectorAll<HTMLElement>("*")])
    for (const attribute of ["aria-describedby", "aria-labelledby"])
      for (const id of (element.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean))
        expect(document.getElementById(id), `${name}: ${attribute} "${id}" resolves`).not.toBeNull();
  // The CH-96 screen-reader note for the saved switch is gone with the switch.
  expect(row.querySelector('[id$="-locked"]'), `${name}: no saved-switch note`).toBeNull();
}
