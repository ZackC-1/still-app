import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import App from "../App.svelte";
import Placeholder from "../components/Placeholder.svelte";
import { UiController, type UiHost } from "../controller.svelte.js";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";

function controller(opts: { host?: Partial<UiHost>; globalOn?: boolean } = {}) {
  const initial = { ...DEFAULT_SETTINGS, globalOn: opts.globalOn ?? true, updatedAt: 1 };
  const cache = new SettingsCache(new InMemoryStorageAdapter(initial), { initial, now: () => Date.now() });
  return new UiController({ cache, host: { canPurchase: true, currentHost: "youtube.com", ...opts.host } });
}

describe("App", () => {
  it("renders a card for each of the four services", () => {
    render(App, { props: { controller: controller() } });
    expect(document.querySelectorAll("[data-service]").length).toBe(4);
  });

  it("global off visually disables the service group", () => {
    render(App, { props: { controller: controller({ globalOn: false }) } });
    const services = document.querySelector(".services");
    expect(services?.getAttribute("aria-disabled")).toBe("true");
  });

  it("not-entitled + can-purchase shows the Get Still Sync CTA", () => {
    const c = controller();
    c.userId = "u";
    render(App, { props: { controller: c } });
    expect(screen.getByText("Get Still Sync")).toBeTruthy();
  });

  it("entitled shows the synced state", () => {
    const c = controller();
    c.userId = "u";
    c.entitled = true;
    render(App, { props: { controller: c } });
    expect(screen.getByText(/Synced across your devices/)).toBeTruthy();
  });

  it("non-Apple host shows the explanatory paywall, never a purchasable CTA (R19)", () => {
    const c = controller({ host: { canPurchase: false } });
    c.userId = "u";
    render(App, { props: { controller: c } });
    expect(screen.queryByText("Get Still Sync")).toBeNull();
    expect(screen.getByText(/Buy once on iPhone/)).toBeTruthy();
  });

  it("Apple host (onSignInWithApple) shows the Apple button, not the email field (U19)", () => {
    render(App, { props: { controller: controller(), onSignInWithApple: () => {} } });
    expect(screen.getByText("Sign in with Apple")).toBeTruthy();
    expect(document.querySelector("input.email")).toBeNull();
  });

  it("non-Apple host keeps the email magic-link sign-in", () => {
    render(App, { props: { controller: controller() } });
    expect(document.querySelector("input.email")).toBeTruthy();
    expect(screen.queryByText("Sign in with Apple")).toBeNull();
  });
});

describe("Placeholder", () => {
  it("renders one calm line and no buttons (no scolding)", () => {
    render(Placeholder, { props: {} });
    expect(screen.getByText(/Nothing here/)).toBeTruthy();
    expect(document.querySelectorAll("button").length).toBe(0);
  });
});
