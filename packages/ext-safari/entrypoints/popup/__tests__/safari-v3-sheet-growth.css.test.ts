import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/svelte";
import { startSafariV3Popup } from "../v3.js";
import { installSafari } from "./safari-native.fixture.js";

// Review F-5 (22 Oct): the iPhone and iPad popup grows to fit an open site (canvas Safari-Popup-
// Locked and -ProOpen; ISS-0098 option B). Mounted for real on the mobile surface with the design
// system's and the host's CSS applied: after YouTube opens, neither the page nor the site list caps
// its height, and nothing inside the popup scrolls on its own.
const ENV = { atomicSettingsFlag: "true", modernSyncFlag: undefined, supabaseUrl: undefined, supabaseAnonKey: undefined };

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SafariV3Popup on the mobile surface, rendered with its CSS", () => {
  it("opens YouTube with no capped height and no inner scroller", async () => {
    await installSafari({ saved: "atomic", platform: "ios" });
    document.body.innerHTML = '<div id="app"></div>';
    expect(await startSafariV3Popup({ env: ENV, load: () => import("../v3-mount.js") })).toBe("v3");
    const expander = await screen.findByRole("button", { name: "YouTube Blocker" });
    await fireEvent.click(expander);
    expect(expander.getAttribute("aria-expanded")).toBe("true");

    const popup = document.querySelector<HTMLElement>("#app > .popup")!;
    expect(popup.classList.contains("desktop-popup")).toBe(false);
    const app = popup.querySelector<HTMLElement>('.app[data-density="compact"]')!;
    const list = app.querySelector<HTMLElement>(".site-scroll")!;
    // The design system caps both (600px page, 312px list); the mobile host lifts the caps.
    expect(getComputedStyle(app).getPropertyValue("max-block-size")).toBe("none");
    expect(getComputedStyle(list).getPropertyValue("max-block-size")).toBe("none");
    expect(getComputedStyle(list).overflowY).toBe("visible");
    expect(getComputedStyle(list).flexShrink).toBe("0");
    const scrollers = [popup, ...popup.querySelectorAll<HTMLElement>("*")].filter((element) =>
      ["auto", "scroll"].includes(getComputedStyle(element).overflowY),
    );
    expect(scrollers.map((element) => element.className)).toEqual([]);
  });
});
