import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import SiteAccessCard from "./SiteAccessCard.svelte";
import DesktopPopup from "./DesktopPopup.svelte";
import MobilePopup from "./MobilePopup.svelte";
import ExtensionSettings from "./ExtensionSettings.svelte";
import { fixture as popupFixture } from "./DesktopPopup.fixtures.js";
import { fixture as settingsFixture } from "./ExtensionSettings.test-fixtures.js";
import { siteAccessCard, siteAccessSiteFor } from "./site-access-presentation.js";
import type { MobilePopupProps } from "./mobile-presentation.js";

// ISS-0037: with site access withheld ("When you click the extension" in Chrome, a site removed in
// Chrome or Firefox), Still says plainly that it cannot work on its sites and offers Allow, at the
// top of the popup and the settings page.

const TITLE = "Still can't block distractions yet.";
const BODY = "Still needs permission to work on Instagram, Facebook, YouTube, and TikTok.";

describe("the site access warning card", () => {
  it("names the four sites in the owner's order and asks with Allow", async () => {
    const onAllow = vi.fn();
    render(SiteAccessCard, { props: { state: "needed", browser: "Chrome", onAllow } });
    const card = screen.getByRole("region", { name: TITLE });
    expect(within(card).getByRole("heading", { name: TITLE })).toBeVisible();
    expect(within(card).getByText(BODY)).toBeVisible();
    // The owner chose "yet" for the heading (canvas review, 21 Oct 2026); "everywhere" stays banned.
    expect(card.textContent).not.toMatch(/everywhere/i);
    await fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
    expect(onAllow).toHaveBeenCalledOnce();
  });

  it("names only the missing sites, in the owner's order", () => {
    const view = render(SiteAccessCard, {
      props: { state: "needed", browser: "Firefox", sites: ["YouTube"], onAllow: vi.fn() },
    });
    expect(screen.getByRole("heading", { name: "Still can't block distractions yet." })).toBeVisible();
    expect(screen.getByText("Still needs permission to work on YouTube.")).toBeVisible();
    view.unmount();
    render(SiteAccessCard, {
      props: { state: "needed", browser: "Firefox", sites: ["TikTok", "Facebook"], onAllow: vi.fn() },
    });
    expect(screen.getByRole("heading", { name: TITLE })).toBeVisible();
    expect(screen.getByText("Still needs permission to work on Facebook and TikTok.")).toBeVisible();
  });

  it("keeps one status line and one button in place from Allow to waiting to Try again", async () => {
    const onAllow = vi.fn();
    const view = render(SiteAccessCard, { props: { state: "needed", browser: "Chrome", onAllow } });
    const status = screen.getByRole("status");
    const button = screen.getByRole("button", { name: "Allow" });
    expect(status).toHaveTextContent("");
    button.focus();
    await fireEvent.click(button);
    expect(onAllow).toHaveBeenCalledOnce();

    await view.rerender({ state: "pending", browser: "Chrome", onAllow });
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Waiting for Chrome…");
    expect(screen.getByRole("button", { name: "Allow" })).toBe(button);
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(button);
    await fireEvent.click(button);
    expect(onAllow).toHaveBeenCalledOnce();

    await view.rerender({ state: "denied", browser: "Chrome", onAllow });
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent(
      "Chrome didn't allow it. Your choices are saved and start working once it's allowed.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBe(button);
    await fireEvent.click(button);
    expect(onAllow).toHaveBeenCalledTimes(2);
  });

  it("says access is back, and to reload open tabs, then moves focus there from the button", async () => {
    const onAllow = vi.fn();
    const view = render(SiteAccessCard, { props: { state: "needed", browser: "Chrome", onAllow } });
    const status = screen.getByRole("status");
    const button = screen.getByRole("button", { name: "Allow" });
    button.focus();
    await fireEvent.click(button);
    await view.rerender({ state: "allowed", browser: "Chrome", onAllow });
    const heading = screen.getByRole("heading", {
      name: "Allowed on Instagram, Facebook, YouTube, and TikTok.",
    });
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Reload open tabs to apply.");
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.activeElement).toBe(heading);
  });

  it("does not take focus when access came back without a tap here", async () => {
    const view = render(SiteAccessCard, { props: { state: "needed", browser: "Chrome", onAllow: vi.fn() } });
    await view.rerender({ state: "allowed", browser: "Chrome" });
    expect(screen.getByRole("status")).toHaveTextContent("Reload open tabs to apply.");
    expect(document.activeElement).toBe(document.body);
  });

  it("offers no button where the browser cannot ask from this page", () => {
    render(SiteAccessCard, { props: { state: "needed", browser: "Chrome" } });
    expect(screen.getByRole("region", { name: TITLE })).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("siteAccessCard (the browser's answer to the warning)", () => {
  it("warns only once the browser has said access is missing, and says when it is back", () => {
    const onAllow = () => {};
    expect(siteAccessCard("unknown", "Chrome", onAllow)).toBeUndefined();
    expect(siteAccessCard("granted", "Chrome", onAllow)).toBeUndefined();
    expect(siteAccessCard("granted", "Chrome", onAllow, { warned: true })).toEqual({
      state: "allowed",
      browser: "Chrome",
    });
    expect(siteAccessCard("needed", "Chrome", onAllow, { sites: ["YouTube"] })).toEqual({
      state: "needed",
      browser: "Chrome",
      sites: ["YouTube"],
      onAllow,
    });
    expect(siteAccessCard("pending", "Firefox", undefined)?.state).toBe("pending");
    expect(siteAccessCard("denied", "Firefox", onAllow)?.state).toBe("denied");
  });

  it("maps each declared host pattern to its site", () => {
    expect(
      ["*://*.youtube.com/*", "*://*.instagram.com/*", "*://*.facebook.com/*", "*://*.tiktok.com/*", "*://*.example.com/*"].map(
        siteAccessSiteFor,
      ),
    ).toEqual(["YouTube", "Instagram", "Facebook", "TikTok", undefined]);
  });
});

/** The warning sits above the site list: it precedes the first site's switch in the document. */
function expectAboveSiteList() {
  const card = screen.getByRole("region", { name: TITLE });
  const firstSite = screen.getByRole("switch", { name: "Still on Instagram" });
  expect(card.compareDocumentPosition(firstSite) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

describe("where the warning appears", () => {
  it("desktop popup: at the top, above the site list, and nowhere without a warning", async () => {
    const { props } = await popupFixture();
    const onAllow = vi.fn();
    const view = render(DesktopPopup, {
      props: { ...props, siteAccess: { state: "needed", browser: "Chrome", onAllow } },
    });
    expectAboveSiteList();
    await fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onAllow).toHaveBeenCalledOnce();
    await view.rerender({ ...props, siteAccess: undefined });
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
  });

  it("phone popup (Firefox for Android): at the top, above the site list", async () => {
    const { props } = await popupFixture();
    const { browser: _browser, ...rest } = props;
    const mobile: MobilePopupProps = {
      ...rest,
      host: "firefox",
      siteAccess: { state: "needed", browser: "Firefox", onAllow: vi.fn() },
    };
    render(MobilePopup, { props: mobile });
    expectAboveSiteList();
  });

  it("phone popup in Safari: no warning unless the host supplies one", async () => {
    const { props } = await popupFixture();
    const { browser: _browser, ...rest } = props;
    render(MobilePopup, { props: { ...rest, host: "safari" } });
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
  });

  it("settings page: at the top, above the site list", async () => {
    const { props } = await settingsFixture();
    const onAllow = vi.fn();
    render(ExtensionSettings, {
      props: { ...props, siteAccess: { state: "denied", browser: "Chrome", onAllow } },
    });
    expectAboveSiteList();
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onAllow).toHaveBeenCalledOnce();
  });
});
