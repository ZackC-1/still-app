import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import SiteAccessCard from "./SiteAccessCard.svelte";
import DesktopPopup from "./DesktopPopup.svelte";
import MobilePopup from "./MobilePopup.svelte";
import ExtensionSettings from "./ExtensionSettings.svelte";
import { fixture as popupFixture } from "./DesktopPopup.fixtures.js";
import { fixture as settingsFixture } from "./ExtensionSettings.test-fixtures.js";
import { siteAccessCard } from "./site-access-presentation.js";
import type { MobilePopupProps } from "./mobile-presentation.js";

// ISS-0037: with site access withheld ("When you click the extension" in Chrome, a site removed in
// Chrome or Firefox), Still says plainly that it cannot work on its sites and offers Allow, at the
// top of the popup and the settings page.

const TITLE = "Still can't work on these sites yet";
const BODY = "Still needs permission to work on Instagram, Facebook, YouTube, and TikTok.";

describe("the site access warning card", () => {
  it("names the four sites in the owner's order and asks with Allow", async () => {
    const onAllow = vi.fn();
    render(SiteAccessCard, { props: { state: "needed", browser: "Chrome", onAllow } });
    const card = screen.getByRole("region", { name: TITLE });
    expect(within(card).getByRole("heading", { name: TITLE })).toBeVisible();
    expect(within(card).getByText(BODY)).toBeVisible();
    expect(card.textContent).not.toMatch(/everywhere/i);
    await fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
    expect(onAllow).toHaveBeenCalledOnce();
  });

  it("shows the browser's prompt is open, with no second button, while it is pending", () => {
    const onAllow = vi.fn();
    render(SiteAccessCard, { props: { state: "pending", browser: "Firefox", onAllow } });
    const card = screen.getByRole("region", { name: TITLE });
    expect(within(card).getByRole("status")).toHaveTextContent("Waiting for Firefox…");
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("says the browser did not allow it and offers Try again after a declined prompt", async () => {
    const onAllow = vi.fn();
    render(SiteAccessCard, { props: { state: "denied", browser: "Chrome", onAllow } });
    const card = screen.getByRole("region", { name: TITLE });
    expect(within(card).getByRole("status")).toHaveTextContent(
      "Chrome didn't allow it. Your choices are saved and start working once it's allowed.",
    );
    await fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(onAllow).toHaveBeenCalledOnce();
  });

  it("offers no button where the browser cannot ask from this page", () => {
    render(SiteAccessCard, { props: { state: "needed", browser: "Chrome" } });
    expect(screen.getByRole("region", { name: TITLE })).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("siteAccessCard (the browser's answer to the warning)", () => {
  it("warns only once the browser has said access is missing", () => {
    const onAllow = () => {};
    expect(siteAccessCard("unknown", "Chrome", onAllow)).toBeUndefined();
    expect(siteAccessCard("granted", "Chrome", onAllow)).toBeUndefined();
    expect(siteAccessCard("needed", "Chrome", onAllow)).toEqual({
      state: "needed",
      browser: "Chrome",
      onAllow,
    });
    expect(siteAccessCard("pending", "Firefox", undefined)).toEqual({
      state: "pending",
      browser: "Firefox",
      onAllow: undefined,
    });
    expect(siteAccessCard("denied", "Firefox", onAllow)?.state).toBe("denied");
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
