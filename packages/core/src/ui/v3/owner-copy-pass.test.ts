import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import DesktopPopup from "./DesktopPopup.svelte";
import MobilePopup from "./MobilePopup.svelte";
import ExtensionSettings from "./ExtensionSettings.svelte";
import SyncCard from "./SyncCard.svelte";
import ProOfferCard from "./ProOfferCard.svelte";
import { fixture as popupFixture } from "./DesktopPopup.fixtures.js";
import { fixture as settingsFixture } from "./ExtensionSettings.test-fixtures.js";

// ISS-0029 (owner copy and layout pass, 12 Oct 2026), the parts every shared web surface draws the
// same way: Chrome, Firefox and Firefox for Android (DesktopPopup / MobilePopup / ExtensionSettings)
// and the Safari popup on Mac and iPhone (MobilePopup, host "safari"). The Apple app's settings
// screen is pinned in AppleSettings.test.ts.

afterEach(cleanup);

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(join(here, file), "utf8");

const SITE_ORDER = ["Instagram Blocker", "Facebook Blocker", "YouTube Blocker", "TikTok Blocker"];
const sections = () =>
  [...document.querySelectorAll(".service-row .name")].map((name) => name.textContent?.trim());

describe("site order (item 7): Instagram, Facebook, YouTube, TikTok", () => {
  it("desktop popup (Chrome, Firefox)", async () => {
    const { props } = await popupFixture();
    render(DesktopPopup, { props });
    expect(sections()).toEqual(SITE_ORDER);
  });

  it.each(["safari", "firefox"] as const)("phone popup (%s)", async (host) => {
    const { props } = await popupFixture();
    const { browser: _browser, ...mobile } = props;
    render(MobilePopup, { props: { ...mobile, host, channelReady: true } });
    expect(sections()).toEqual(SITE_ORDER);
  });

  it("settings page", async () => {
    const { props } = await settingsFixture();
    render(ExtensionSettings, { props });
    expect(sections()).toEqual(SITE_ORDER);
  });
});

describe("headings (item 5): Settings sync matches Still Pro", () => {
  it("the settings card uses the shared card heading, like the Still Pro card", () => {
    render(SyncCard, { props: { onSignIn: vi.fn() } });
    const sync = screen.getByRole("heading", { name: "Settings sync" });
    render(ProOfferCard, {
      props: { ownership: "none", knownMissing: true, confirmedAccount: false, channel: "unavailable" },
    });
    const pro = screen.getByRole("heading", { name: "Still Pro" });
    expect(sync.className).toBe("card-title");
    expect(pro.className).toBe("card-title");
  });

  it("the popups draw it at the card heading's size, weight and colour", () => {
    const css = source("design/tokens/components.css");
    const rule = (selector: string) =>
      css.match(new RegExp(`^\\${selector} \\{([^}]*)\\}`, "m"))?.[1]?.replace(/margin:[^;]*;/, "").trim();
    expect(rule(".sync-row-title")).toBe(rule(".card-title"));
    // DesktopPopup no longer overrides the size or tracking.
    const desktop = source("DesktopPopup.svelte");
    const style = desktop.slice(desktop.indexOf("<style>"));
    expect(style).not.toMatch(/\.sync-row-title[^}]*font-size/);
    expect(style).not.toMatch(/\.sync-row-title[^}]*letter-spacing/);
  });
});

describe("Help card (item 8): three links, no heading, divider or note", () => {
  it("settings page", async () => {
    const { props } = await settingsFixture();
    render(ExtensionSettings, { props });
    expect(screen.queryByRole("heading", { name: "Help" })).toBeNull();
    expect(screen.queryByText(/Contact support opens your email app/)).toBeNull();
    const help = screen.getByRole("region", { name: "Help" });
    expect(within(help).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual([
      "Setup guide",
      "Privacy policy",
      "Contact support",
    ]);
    expect(help.querySelector(".account, .section-label, .caption")).toBeNull();
  });
});

describe("popup footer (item 12): links clear of rounded sheet corners", () => {
  it("pads the footer 16px on each side, inside the popup's own padding", () => {
    const css = source("design/tokens/components.css");
    const footer = css.match(/^\.popup-footer \{([^}]*)\}/m)?.[1] ?? "";
    expect(footer).toContain("padding-inline: var(--space-4);");
  });
});

describe("verify states (item 6): one line plus its action", () => {
  it("the app card's purchase-needs-verifying state has no extra line", async () => {
    const { default: NativeProOfferCard } = await import("./NativeProOfferCard.svelte");
    const view = render(NativeProOfferCard, {
      props: { ownership: "none", channel: "ready", verificationRequired: true, onRestore: vi.fn() },
    });
    const body = view.container.querySelector(".status-line .status-body")!;
    expect(body.textContent?.trim()).toBe("Your purchase needs to be verified.");
    expect(view.container.textContent).not.toContain("Go online");
  });
});
