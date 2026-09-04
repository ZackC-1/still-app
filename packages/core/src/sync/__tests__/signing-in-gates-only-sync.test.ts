// What signing in and signing out are allowed to change.
//
// The product promise is narrow and worth pinning: an account buys cross-device settings sync and
// nothing else. Somebody who never signs in gets the whole product on that device, and signing out
// takes only the sync away. That promise spans two subsystems, so the last case here drives the
// REAL extension sign-out (the shared teardown a browser actually runs) into the REAL content
// script (the thing that blocks), rather than hand-feeding the value the teardown is supposed to
// write. A teardown that wrote something else would move those assertions instead of hiding
// between the two halves. The earlier cases state each entitlement value directly, which is the
// right shape for "no account at all" and "an account that owns nothing", because neither of those
// is produced by a teardown.
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
import { createExtensionSession, type CheckoutPendingRecord, type PendingOtpRecord, type PersistedSlot } from "../extension-session.js";
import type { EntitlementRead, ReconcileCallOutcome, RequestCodeOutcome, VerifyCodeOutcome, WebCheckoutOutcome } from "../ports.js";
import { SyncService } from "../service.js";

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
  return blockingResultFrom(
    href,
    entitled === null ? null : new InMemoryEntitlementAdapter(entitled),
  );
}

/** The same run, reading a specific entitlement store, so a real teardown's write can drive it. */
async function blockingResultFrom(href: string, entitlement: InMemoryEntitlementAdapter | null) {
  document.documentElement.className = "";
  document.body.innerHTML = "";
  const script = createContentScript({
    win: makeWin(href),
    doc: document,
    ruleSet,
    cache: settingsCache(),
    ...(entitlement === null ? {} : { entitlement: new EntitlementCache(entitlement) }),
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

/** A slot the extension session can persist into, with nothing in it. */
function emptySlot<T>(): PersistedSlot<T> {
  let value: unknown = null;
  return {
    get: async () => value,
    set: async (v: T | null) => {
      value = v;
    },
  };
}

/**
 * The real extension session over in-memory fakes, wired the way the background wires it, holding
 * the entitlement store the content script below reads. Signing out here is the shipped teardown.
 */
function extensionSession(records: InMemoryEntitlementAdapter) {
  const auth = {
    signInWithMagicLink: vi.fn(async () => ({})),
    signOut: vi.fn(async () => {}),
    currentUserId: vi.fn(async (): Promise<string | null> => "u1"),
    requestCode: vi.fn(async (): Promise<RequestCodeOutcome> => ({ kind: "sent" })),
    verifyCode: vi.fn(async (): Promise<VerifyCodeOutcome> => ({ kind: "verified", userId: "u1" })),
  };
  const backend = {
    reconcileEntitlement: vi.fn(async () => {}),
    reconcileEntitlementChecked: vi.fn(async (): Promise<ReconcileCallOutcome> => "ok"),
    readEntitlement: vi.fn(async (): Promise<EntitlementRead> => "entitled"),
    readProfile: vi.fn(async () => null),
    writeProfile: vi.fn(async (settings) => ({
      settings,
      version: 1,
      serverUpdatedAt: new Date(1).toISOString(),
      lastWriteId: null,
    })),
    subscribeToProfile: vi.fn(() => vi.fn()),
    deleteAccount: vi.fn(async () => {}),
    createWebCheckout: vi.fn(
      async (): Promise<WebCheckoutOutcome> => ({ kind: "checkout-url", url: "https://pay.rev.cat/t/u1" }),
    ),
  };
  let lastSynced: string | null = null;
  const identity = {
    get: async () => lastSynced,
    set: async (userId: string) => {
      lastSynced = userId;
    },
  };
  return createExtensionSession({
    auth,
    backend,
    records,
    sync: new SyncService(settingsCache(), auth, backend, undefined, identity),
    identity,
    stores: {
      pendingOtp: emptySlot<PendingOtpRecord>(),
      checkoutPending: emptySlot<CheckoutPendingRecord>(),
      nudgeStamp: emptySlot<number>(),
    },
    closeTab: vi.fn(async () => {}),
  });
}

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

  includedAccessIt("signing out for real does not degrade blocking", async () => {
    // The shared teardown a browser actually runs, into the record every content script reads.
    // Whatever it writes is what blocking has to survive, so nothing here states that value.
    const records = new InMemoryEntitlementAdapter(true);
    const session = extensionSession(records);
    const before: Record<string, unknown>[] = [];
    for (const page of PAID_ERA_PAGES) before.push(await blockingResultFrom(page, records));

    expect(await session.signOut()).toBe("signed-out");
    // The teardown's own write, read back rather than assumed: an explicit false, not a removal.
    expect(await records.getRecord()).toMatchObject({ entitled: false });

    for (const [index, page] of PAID_ERA_PAGES.entries()) {
      expect(await blockingResultFrom(page, records)).toEqual(before[index]);
    }
    for (const result of before) expect(result).toMatchObject({ placeholder: true });
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
