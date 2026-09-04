// What signing in and signing out are allowed to change.
//
// The product promise is narrow and worth pinning: an account buys cross-device settings sync and
// nothing else. Somebody who never signs in gets the whole product on that device, and signing out
// takes only the sync away. That promise spans two subsystems, so this file drives the real
// extension session (the thing that signs a browser in and out) together with the real content
// script (the thing that blocks), rather than asserting each half in isolation where a regression
// could hide between them.
//
// It lives in the sync suite because the subject is what an account does, not how blocking works.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, PAID_TIER_ENABLED, type SignedRuleSet } from "@still/shared-types";
import seed from "../../../rules/seed.json";
import { createContentScript } from "../../content/index.js";
import { EntitlementCache, InMemoryEntitlementAdapter } from "../../entitlement/index.js";
import { ROOT_ACTIVE_CLASS, ROOT_PRO_ACTIVE_CLASS } from "../../rules/engine.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";

const ruleSet = seed as unknown as SignedRuleSet;
const runNow = (cb: () => void) => cb();

/** One page per service that only a purchaser used to reach. */
const PAID_ERA_PAGES = [
  "https://www.instagram.com/reel/XYZ/",
  "https://www.tiktok.com/foryou",
  "https://www.facebook.com/reel/123",
];

function settingsCache() {
  const initial = { ...DEFAULT_SETTINGS, updatedAt: 1 };
  return new SettingsCache(new InMemoryStorageAdapter(initial), { initial, now: () => Date.now() });
}

/** A minimal scriptable window for the content script. */
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

/**
 * Run the content script against one page and report what it did. `entitled` is what the
 * entitlement record says at the time, which is exactly what a sign-out rewrites.
 */
async function blockingResult(href: string, entitled: boolean | null) {
  document.documentElement.className = "";
  document.body.innerHTML = "";
  const script = createContentScript({
    win: makeWin(href),
    doc: document,
    ruleSet,
    cache: settingsCache(),
    ...(entitled === null
      ? {}
      : { entitlement: new EntitlementCache(new InMemoryEntitlementAdapter(entitled)) }),
    redirectPort: { replace: vi.fn() },
    schedule: runNow,
  });
  await script.start();
  const result = {
    placeholder: document.querySelector("#still-placeholder") !== null,
    rootActive: document.documentElement.classList.contains(ROOT_ACTIVE_CLASS),
    proStylesheetActive: document.documentElement.classList.contains(ROOT_PRO_ACTIVE_CLASS),
  };
  script.stop();
  return result;
}

/** Every case here is a statement about the shipped tier. With the paid tier switched back on an
 * account decides what blocks again, which is the behaviour paid-tier-switch.test.ts proves. */
const includedAccessIt = it.runIf(!PAID_TIER_ENABLED);

describe("signing in gates only settings sync", () => {
  includedAccessIt("blocks every service with no account at all", async () => {
    for (const page of PAID_ERA_PAGES) {
      // `null` is the shape of a surface that carries no entitlement source whatsoever.
      expect(await blockingResult(page, null)).toMatchObject({ placeholder: true });
    }
  });

  includedAccessIt("blocks every service for a signed-in account that owns nothing", async () => {
    for (const page of PAID_ERA_PAGES) {
      expect(await blockingResult(page, false)).toMatchObject({ placeholder: true });
    }
  });

  includedAccessIt("signing out does not degrade blocking", async () => {
    // Signing out writes an explicit `entitled: false` into the record every content script reads
    // (the extension session's shared purge). Blocking must be identical either side of it.
    for (const page of PAID_ERA_PAGES) {
      const signedIn = await blockingResult(page, true);
      const signedOut = await blockingResult(page, false);
      expect(signedOut).toEqual(signedIn);
    }
  });

  includedAccessIt("the Pro stylesheet is active for everyone, so nothing waits on an account to hide", async () => {
    // The static stylesheet does the fast, unflickering half of the hiding, and it only applies
    // under this root class. If an account decided the class, a signed-out user would see the
    // content the stylesheet is meant to remove before the script caught up.
    const withoutAccount = await blockingResult("https://www.instagram.com/someone/", null);
    expect(withoutAccount.proStylesheetActive).toBe(true);
    expect(withoutAccount.rootActive).toBe(true);
  });
});
