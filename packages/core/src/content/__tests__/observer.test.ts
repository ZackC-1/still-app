import { describe, it, expect, beforeEach, vi } from "vitest";
import seed from "../../../rules/seed.json";
import type { SignedRuleSet } from "@still/shared-types";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { createContentScript, createReapplyObserver } from "../index.js";
import { EntitlementCache, InMemoryEntitlementAdapter } from "../../entitlement/index.js";

const ruleSet = seed as unknown as SignedRuleSet;
const sync = (cb: () => void) => cb();
const tick = () => new Promise((r) => setTimeout(r, 0)); // let the MutationObserver microtask flush

function freshCache() {
  return new SettingsCache(new InMemoryStorageAdapter(null), { now: () => Date.now() });
}

/** Minimal scriptable window over the real jsdom document. */
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

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

describe("content script — MutationObserver re-application (U7)", () => {
  it("removes a reel shelf injected after load (lazy / infinite scroll, same URL)", async () => {
    const cs = createContentScript({
      win: makeWin("https://www.youtube.com/feed/subscriptions"),
      doc: document,
      ruleSet,
      cache: freshCache(),
      redirectPort: { replace: vi.fn() },
      schedule: sync,
    });
    await cs.start();
    const shelf = document.createElement("ytd-reel-shelf-renderer");
    shelf.id = "late-shelf";
    document.body.appendChild(shelf);
    await tick();
    expect(document.querySelector("#late-shelf")).toBeNull();
    cs.stop();
  });

  it("catches a same-URL Instagram Reel modal the History hook never sees", async () => {
    // Instagram inline-Reel removal is a Pro surface — pass an entitled cache so the gate is open.
    const cs = createContentScript({
      win: makeWin("https://www.instagram.com/someuser/"),
      doc: document,
      ruleSet,
      cache: freshCache(),
      entitlement: new EntitlementCache(new InMemoryEntitlementAdapter(true)),
      redirectPort: { replace: vi.fn() },
      schedule: sync,
    });
    await cs.start();
    // A Reel opens in a same-URL modal: an <article> containing a /reel/ link is injected.
    const modal = document.createElement("article");
    modal.id = "reel-modal";
    modal.innerHTML = `<a href="/reel/abc">reel</a>`;
    document.body.appendChild(modal);
    await tick();
    expect(document.querySelector("#reel-modal")).toBeNull();
    cs.stop();
  });
});

describe("createReapplyObserver", () => {
  it("re-applies on mutation and stops after disconnect", async () => {
    const reapply = vi.fn();
    const obs = createReapplyObserver(window, document, reapply, sync);
    obs.start();
    document.body.appendChild(document.createElement("div"));
    await tick();
    expect(reapply).toHaveBeenCalled();
    const count = reapply.mock.calls.length;

    obs.stop();
    document.body.appendChild(document.createElement("div"));
    await tick();
    expect(reapply.mock.calls.length).toBe(count); // no further calls after disconnect
  });
});
