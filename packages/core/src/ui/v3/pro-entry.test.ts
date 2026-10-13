// ISS-0032 in builds compiled with the paid tier off (the shipped 2.x and free builds): the Still Pro
// entry points stay dormant and the popups and Settings render exactly as before. The packaged
// access snapshot holds every Still Pro row `unsupported`, so no host port can make an offer appear.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAID_TIER_ENABLED } from "@still/shared-types";
import { initialAccessSnapshot } from "../../entitlement/access-policy.js";
import DesktopPopup from "./DesktopPopup.svelte";
import MobilePopup from "./MobilePopup.svelte";
import ExtensionSettings from "./ExtensionSettings.svelte";
import { fixture as desktopFixture } from "./DesktopPopup.fixtures.js";
import { fixture as settingsFixture } from "./ExtensionSettings.test-fixtures.js";
import { POPUP_PRO_VALUE, proKnownMissing, proValueBySite } from "./presentation.js";
import type { MobilePopupProps } from "./mobile-presentation.js";

afterEach(cleanup);

const ENTRY = /Get Still Pro|Hide more on|One-time purchase|Lifetime access|price is shown/;

/** The popup's top-level parts, in order, by their identifying class or element. */
function parts(container: HTMLElement) {
  const app = container.querySelector(".still-ui.app")!;
  return [...app.children].map((node) =>
    node.classList.contains("hero")
      ? "hero"
      : node.classList.contains("services")
        ? "sites"
        : node.classList.contains("pro-entry")
          ? "pro"
          : node.tagName === "FOOTER"
            ? "footer"
            : node.querySelector(".sync-row-title")?.textContent === "Settings sync"
              ? "sync"
              : node.tagName.toLowerCase(),
  );
}

describe("paid tier off: Still Pro entry stays dormant", () => {
  it("is compiled off in this suite", () => {
    expect(PAID_TIER_ENABLED).toBe(false);
    expect(proKnownMissing(initialAccessSnapshot())).toBe(false);
  });

  it.each(["Chrome", "Firefox"] as const)(
    "%s desktop popup: the same parts as before and no entry, whatever ports the host supplies",
    async (browser) => {
      const { props } = await desktopFixture();
      props.browser = browser;
      props.access = initialAccessSnapshot();
      const bare = render(DesktopPopup, { props });
      const before = bare.container.innerHTML;
      expect(parts(bare.container)).toEqual(["hero", "sites", "sync", "footer"]);
      bare.unmount();
      const seePro = vi.fn();
      const ported = render(DesktopPopup, {
        props: { ...props, onSeePro: seePro },
      });
      // A supplied Pro destination changes nothing while the rows are dormant.
      expect(ported.container.innerHTML).toBe(before);
      expect(document.body.textContent).not.toMatch(ENTRY);
      expect(document.querySelector(".handoff")).toBeNull();
      expect(seePro).not.toHaveBeenCalled();
    },
  );

  it.each(["safari", "firefox"] as const)(
    "%s phone popup: the same parts as before and no entry",
    async (host) => {
      const { props: desktop } = await desktopFixture();
      const { browser: _browser, ...rest } = desktop;
      const props: MobilePopupProps = {
        ...rest,
        access: initialAccessSnapshot(),
        host,
        channelReady: true,
        onSeePro: vi.fn(),
      };
      const view = render(MobilePopup, { props });
      expect(parts(view.container)).toEqual(["hero", "sites", "sync", "footer"]);
      expect(document.body.textContent).not.toMatch(ENTRY);
      expect(props.onSeePro).not.toHaveBeenCalled();
    },
  );

  it("Settings without a paid producer: the sync card keeps its heading and no Still Pro card appears", async () => {
    const { props } = await settingsFixture();
    const { pro: _pro, ...free } = props;
    render(ExtensionSettings, {
      props: { ...free, access: initialAccessSnapshot() },
    });
    expect(screen.getByRole("heading", { name: "Settings sync" })).toBeVisible();
    expect(screen.queryByText("Still Pro and sync")).toBeNull();
    expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull();
    expect(document.body.textContent).not.toMatch(ENTRY);
  });
});

describe("Still Pro copy states no number of extras (owner rule)", () => {
  const COUNT = /\d/;
  it("the popup line and every by-site value line contain no digits", () => {
    expect(POPUP_PRO_VALUE).not.toMatch(COUNT);
    expect(POPUP_PRO_VALUE).toBe(
      "Hide more on Instagram, Facebook and YouTube. One-time purchase.",
    );
    for (const row of proValueBySite()) {
      expect(row.what).not.toMatch(COUNT);
      expect(row.what).not.toMatch(/extras/i);
    }
  });
});
