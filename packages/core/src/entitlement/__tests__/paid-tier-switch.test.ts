// The reversal lever, exercised for real. `PAID_TIER_ENABLED` is a literal in shared-types, so
// every other suite sees whatever it is committed as. This file is the one place that runs the
// real engine, content script, and popup against the switch turned ON, by replacing that single
// export before the modules under test are imported. It is what makes "flipping one boolean
// restores paid gating" a tested claim instead of an assumed one, in the same run as the shipped
// switched-off behavior.
//
// It lives here, beside the entitlement code, because the switch guards entitlement reads and its
// contract spans three subsystems; a copy of it inside each of their suites would be three places
// to forget.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import seed from "../../../rules/seed.json";
import { DEFAULT_SETTINGS, PAID_TIER_ENABLED, type SignedRuleSet } from "@still/shared-types";
import { evaluate, ROOT_PRO_ACTIVE_CLASS } from "../../rules/engine.js";
import { createContentScript } from "../../content/index.js";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { EntitlementCache, InMemoryEntitlementAdapter } from "../index.js";
import App from "../../ui/App.svelte";
import { UiController } from "../../ui/controller.svelte.js";
import { STRINGS } from "../../ui/strings.js";

const ruleSet = seed as unknown as SignedRuleSet;
const sync = (cb: () => void) => cb();
const instagramReel = "https://www.instagram.com/reel/XYZ/";

function settingsCache() {
  const initial = { ...DEFAULT_SETTINGS, updatedAt: 1 };
  return new SettingsCache(new InMemoryStorageAdapter(initial), { initial, now: () => Date.now() });
}

function controller(entitled: boolean) {
  const c = new UiController({ cache: settingsCache(), host: { canPurchase: true } });
  c.entitled = entitled;
  return c;
}

/** A minimal scriptable window for the content script (the same shape the redirect suite uses). */
function makeWin(href: string) {
  return {
    location: { href, replace: vi.fn() },
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame?.bind(window),
  };
}

describe("the paid-tier switch, turned on", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.body.innerHTML = "";
  });

  it("replaces only the switch, leaving the rest of the shared types real", () => {
    expect(PAID_TIER_ENABLED).toBe(true);
    expect(DEFAULT_SETTINGS.services).toHaveProperty("youtube");
  });

  it("restores the engine tier gate: Pro surfaces need entitlement again, YouTube stays free", () => {
    expect(evaluate(ruleSet, DEFAULT_SETTINGS, new URL(instagramReel), { pro: false }).kind).toBe("noop");
    expect(evaluate(ruleSet, DEFAULT_SETTINGS, new URL("https://www.tiktok.com/foryou"), { pro: false }).kind).toBe("noop");
    expect(evaluate(ruleSet, DEFAULT_SETTINGS, new URL("https://www.facebook.com/reel/123"), { pro: false }).kind).toBe("noop");

    expect(evaluate(ruleSet, DEFAULT_SETTINGS, new URL(instagramReel), { pro: true }).kind).toBe("placeholder");
    expect(evaluate(ruleSet, DEFAULT_SETTINGS, new URL("https://www.youtube.com/"), { pro: false }).kind).toBe("apply");
  });

  it("restores the content script gate and the static Pro stylesheet root class", async () => {
    const free = createContentScript({
      win: makeWin(instagramReel),
      doc: document,
      ruleSet,
      cache: settingsCache(),
      redirectPort: { replace: vi.fn() },
      schedule: sync,
    });
    await free.start();
    expect(document.querySelector("#still-placeholder")).toBeNull();
    expect(document.documentElement.classList.contains(ROOT_PRO_ACTIVE_CLASS)).toBe(false);
    free.stop();

    const purchaser = createContentScript({
      win: makeWin("https://www.instagram.com/someone/"),
      doc: document,
      ruleSet,
      cache: settingsCache(),
      entitlement: new EntitlementCache(new InMemoryEntitlementAdapter(true)),
      redirectPort: { replace: vi.fn() },
      schedule: sync,
    });
    await purchaser.start();
    expect(document.documentElement.classList.contains(ROOT_PRO_ACTIVE_CLASS)).toBe(true);
    purchaser.stop();
  });

  it("restores locked rows and makes the paywall reachable again from a locked row", async () => {
    const c = controller(false);
    expect(c.isLocked("instagram")).toBe(true);
    expect(c.isLocked("tiktok")).toBe(true);
    expect(c.isLocked("facebook")).toBe(true);
    expect(c.isLocked("youtube")).toBe(false);

    render(App, { props: { controller: c } });
    expect(document.querySelectorAll(".card.locked")).toHaveLength(3);
    await fireEvent.click(document.querySelector(".lock")!);
    expect(c.paywallOpen).toBe(true);
    expect(screen.getByRole("dialog")).toBeTruthy();
    c.dismissPaywall();
  });

  it("restores the upgrade call to action for a signed-in user who has not bought", () => {
    const c = controller(false);
    c.userId = "u";
    render(App, { props: { controller: c } });
    expect(screen.getByText(STRINGS.paywall.upgradeCta)).toBeTruthy();
  });

  it("leaves an existing purchaser fully unlocked with the switch on", () => {
    const c = controller(true);
    expect(c.entitled).toBe(true);
    for (const id of ["youtube", "instagram", "tiktok", "facebook"] as const) {
      expect(c.isLocked(id)).toBe(false);
    }
    expect(evaluate(ruleSet, DEFAULT_SETTINGS, new URL(instagramReel), { pro: true }).kind).toBe("placeholder");
  });
});
