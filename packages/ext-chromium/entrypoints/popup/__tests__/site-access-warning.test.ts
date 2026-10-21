import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { fixture as popupFixture } from "../../../../core/src/ui/v3/DesktopPopup.fixtures.js";
import { fixture as settingsFixture } from "../../../../core/src/ui/v3/ExtensionSettings.test-fixtures.js";
import { configurePopupInvitationHost } from "../../../lib/invitation-popup-host.js";
import { stillManifest } from "../../../wxt.config.js";
import type { SiteAccessCardPorts } from "../../../lib/site-access-card.svelte.js";
import InvitedDesktopPopup from "../InvitedDesktopPopup.svelte";
import FirefoxAndroidPopup from "../FirefoxAndroidPopup.svelte";
import RestoreSettings from "../../options/RestoreSettings.svelte";
import InformationalProSettings from "../../options/InformationalProSettings.svelte";
import SiteAccessHarness from "./SiteAccessHarness.svelte";

// ISS-0037: the V3 popup and settings wrappers ask the browser whether Still has its four declared
// sites each time they open, warn at the top while it does not, and ask for exactly those four
// sites from Allow, inside the click. They follow grants and removals made while they are open.

afterEach(() => {
  cleanup();
  configurePopupInvitationHost(null);
  vi.unstubAllGlobals();
});

const TITLE = "Still can't block distractions yet.";
const ALLOWED = "Allowed on Instagram, Facebook, YouTube, and TikTok.";
const RELOAD = "Reload open tabs to apply.";
const FOUR_SITES = [
  "*://*.youtube.com/*",
  "*://*.instagram.com/*",
  "*://*.facebook.com/*",
  "*://*.tiktok.com/*",
];

/** A fake chrome.permissions holding the browser's grant, installed as the page's `chrome`. */
function installBrowser(granted: boolean) {
  const added = new Set<() => void>();
  const removed = new Set<() => void>();
  let answer: (granted: boolean) => void = () => {};
  const permissions = {
    granted,
    contains: vi.fn(async (_query: { origins: string[] }) => permissions.granted),
    request: vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    ),
    onAdded: { addListener: (l: () => void) => added.add(l), removeListener: (l: () => void) => added.delete(l) },
    onRemoved: { addListener: (l: () => void) => removed.add(l), removeListener: (l: () => void) => removed.delete(l) },
  };
  vi.stubGlobal("chrome", {
    permissions,
    runtime: { getManifest: () => stillManifest("chrome") },
  });
  return {
    permissions,
    /** The person answers the browser's prompt; a grant also fires the browser's added event. */
    answer(value: boolean) {
      if (value) permissions.granted = true;
      answer(value);
      if (value) added.forEach((l) => l());
    },
    /** Site access is withdrawn in the browser's own settings while the page is open. */
    withdraw() {
      permissions.granted = false;
      removed.forEach((l) => l());
    },
    listeners: () => added.size + removed.size,
  };
}

describe("the V3 desktop popup's site access warning", () => {
  it("shows nothing while the browser reports the four sites allowed", async () => {
    const browser = installBrowser(true);
    const { props } = await popupFixture();
    render(InvitedDesktopPopup, { props });
    await waitFor(() => expect(browser.permissions.contains).toHaveBeenCalledWith({ origins: FOUR_SITES }));
    await browser.permissions.contains.mock.results[0]!.value;
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("switch", { name: "Still on Instagram" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
  });

  it("warns when access is withheld, asks for exactly the four sites inside the click, and clears on the grant", async () => {
    const browser = installBrowser(false);
    const { props } = await popupFixture();
    render(InvitedDesktopPopup, { props });
    const card = await screen.findByRole("region", { name: TITLE });
    expect(
      within(card).getByText("Still needs permission to work on Instagram, Facebook, YouTube, and TikTok."),
    ).toBeTruthy();
    await fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
    // Synchronous with the click: the browser shows its prompt only inside the person's tap.
    expect(browser.permissions.request).toHaveBeenCalledOnce();
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: FOUR_SITES });
    expect(await within(card).findByText("Waiting for Chrome…")).toBeTruthy();
    browser.answer(true);
    const allowed = await screen.findByRole("region", { name: ALLOWED });
    expect(within(allowed).getByRole("status").textContent).toBe(RELOAD);
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
  });

  it("says Chrome didn't allow it, and offers Try again, when the prompt is declined", async () => {
    const browser = installBrowser(false);
    const { props } = await popupFixture();
    render(InvitedDesktopPopup, { props });
    await fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    browser.answer(false);
    expect(await screen.findByText(/Chrome didn't allow it\./)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(browser.permissions.request).toHaveBeenCalledTimes(2);
  });

  it("appears when access is withdrawn while it is open, and stops listening when it closes", async () => {
    const browser = installBrowser(true);
    const { props } = await popupFixture();
    const view = render(InvitedDesktopPopup, { props });
    await waitFor(() => expect(browser.listeners()).toBe(2));
    browser.withdraw();
    expect(await screen.findByRole("region", { name: TITLE })).toBeTruthy();
    view.unmount();
    expect(browser.listeners()).toBe(0);
  });

  it("re-asks the browser when the page becomes visible again", async () => {
    const browser = installBrowser(true);
    const { props } = await popupFixture();
    render(InvitedDesktopPopup, { props });
    await waitFor(() => expect(browser.permissions.contains).toHaveBeenCalledOnce());
    browser.permissions.granted = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByRole("region", { name: TITLE })).toBeTruthy();
  });
});

describe("naming only the missing sites", () => {
  it("asks site by site and names only YouTube when only youtube.com was turned off", async () => {
    const browser = installBrowser(false);
    browser.permissions.contains.mockImplementation(async ({ origins }: { origins: string[] }) =>
      origins.every((origin) => origin !== "*://*.youtube.com/*"),
    );
    const { props } = await popupFixture();
    render(InvitedDesktopPopup, { props });
    const card = await screen.findByRole("region", { name: "Still can't block distractions yet." });
    expect(await within(card).findByText("Still needs permission to work on YouTube.")).toBeTruthy();
    // Allow still asks for the four declared sites; the browser prompts only for the missing one.
    await fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: FOUR_SITES });
  });
});

describe("the popup's invitation waits for the browser's access answer", () => {
  it("asks the background nothing until the browser has answered", async () => {
    const browser = installBrowser(true);
    let answer!: (granted: boolean) => void;
    browser.permissions.contains.mockImplementation(
      () => new Promise<boolean>((resolve) => (answer = resolve)),
    );
    const present = vi.fn(async () => null);
    configurePopupInvitationHost({
      controller: { userId: null, openSignIn: vi.fn() },
      port: { present, commit: vi.fn(async () => true) },
      opening: "opening-1",
      surface: "chrome",
      started: false,
    } as unknown as Parameters<typeof configurePopupInvitationHost>[0]);
    const { props } = await popupFixture();
    render(InvitedDesktopPopup, { props });
    await new Promise((r) => setTimeout(r, 20));
    expect(present).not.toHaveBeenCalled();
    answer(true);
    await waitFor(() => expect(present).toHaveBeenCalledWith("opening-1", undefined));
  });
});

describe("Firefox for Android's popup", () => {
  it("shows the same warning at the top of the phone popup", async () => {
    installBrowser(false);
    const { props } = await popupFixture();
    render(FirefoxAndroidPopup, { props: { ...props, browser: "Firefox" } });
    const card = await screen.findByRole("region", { name: TITLE });
    expect(within(card).getByRole("button", { name: "Allow" })).toBeTruthy();
  });
});

describe("the V3 settings page's site access warning", () => {
  it.each([
    ["free settings page", RestoreSettings],
    ["paid-tier settings page", InformationalProSettings],
  ] as const)("%s: warns at the top and asks for the four sites from Allow", async (_name, Settings) => {
    const browser = installBrowser(false);
    const { props } = await settingsFixture();
    render(Settings, { props });
    const card = await screen.findByRole("region", { name: TITLE });
    const firstSite = screen.getByRole("switch", { name: "Still on Instagram" });
    expect(card.compareDocumentPosition(firstSite) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: FOUR_SITES });
    browser.answer(true);
    expect(await screen.findByText(RELOAD)).toBeTruthy();
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
  });

  it("free settings page: nothing while allowed", async () => {
    const browser = installBrowser(true);
    const { props } = await settingsFixture();
    render(RestoreSettings, { props });
    await waitFor(() => expect(browser.permissions.contains).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
  });
});

describe("the popup's one invitation while the warning shows", () => {
  it("is held, never committed, so a rating or sync ask is not spent while Still cannot work", async () => {
    installBrowser(false);
    const { props } = await popupFixture();
    const commit = vi.fn(async () => true);
    const present = vi.fn(async () => {
      // The background decides after the browser has answered the access question.
      await new Promise((r) => setTimeout(r, 20));
      return {
        installation: "install-1",
        reservation: { kind: "rating" as const, opening: "opening-1", generation: 1 },
      };
    });
    configurePopupInvitationHost({
      controller: { userId: null, openSignIn: vi.fn() },
      port: { present, commit },
      opening: "opening-1",
      surface: "chrome",
      started: false,
    } as unknown as Parameters<typeof configurePopupInvitationHost>[0]);
    render(InvitedDesktopPopup, { props });
    expect(await screen.findByRole("region", { name: TITLE })).toBeTruthy();
    await waitFor(() => expect(present).toHaveBeenCalledOnce());
    await new Promise((r) => setTimeout(r, 40));
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("useSiteAccessCard with the browser's ports", () => {
  function ports(overrides: Partial<SiteAccessCardPorts>): () => SiteAccessCardPorts {
    return () => ({
      permissions: undefined,
      manifest: stillManifest("firefox"),
      name: "Firefox",
      doc: document,
      ...overrides,
    });
  }

  it("names Firefox in the waiting line on the Firefox build", async () => {
    const browser = installBrowser(false);
    render(SiteAccessHarness, { props: { ports: ports({ permissions: browser.permissions }) } });
    await fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText("Waiting for Firefox…")).toBeTruthy();
  });

  it("shows nothing where the browser has no permissions API", async () => {
    render(SiteAccessHarness, { props: { ports: ports({}) } });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
  });

  it("does not re-ask while the page is hidden", async () => {
    const browser = installBrowser(true);
    const hidden = Object.assign(new EventTarget(), { visibilityState: "hidden" }) as unknown as Document;
    render(SiteAccessHarness, {
      props: { ports: ports({ permissions: browser.permissions, doc: hidden }) },
    });
    await waitFor(() => expect(browser.permissions.contains).toHaveBeenCalledOnce());
    hidden.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 10));
    expect(browser.permissions.contains).toHaveBeenCalledOnce();
  });
});
