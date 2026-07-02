import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeEntitlementAdapter, ENTITLEMENT_CACHE_TTL_MS } from "../chrome-adapter.js";

const STORAGE_KEY = "still:entitlement";

type Listener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;

// Minimal in-memory chrome.storage.local + onChanged so the adapter's TTL/round-trip/subscribe paths
// run without a browser. set() fans out to onChanged listeners exactly like the real API.
function installChrome(initial: Record<string, unknown> = {}): { store: Record<string, unknown> } {
  const store: Record<string, unknown> = { ...initial };
  const listeners = new Set<Listener>();
  const chromeMock = {
    storage: {
      local: {
        get: (key: string) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
        set: (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) {
            const oldValue = store[k];
            store[k] = v;
            for (const l of listeners) l({ [k]: { oldValue, newValue: v } }, "local");
          }
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (l: Listener) => listeners.add(l),
        removeListener: (l: Listener) => listeners.delete(l),
      },
    },
  };
  vi.stubGlobal("chrome", chromeMock);
  return { store };
}

afterEach(() => vi.unstubAllGlobals());

describe("ChromeEntitlementAdapter — offline TTL", () => {
  const NOW = 1_700_000_000_000;

  it("honors a fresh entitled cache within the TTL", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true, updatedAt: NOW - 1000 } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.get()).toBe(true);
  });

  it("honors an entitled cache just inside the TTL boundary", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true, updatedAt: NOW - (ENTITLEMENT_CACHE_TTL_MS - 1) } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.get()).toBe(true);
  });

  it("drops an entitled cache past the TTL (downgrades to free)", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true, updatedAt: NOW - (ENTITLEMENT_CACHE_TTL_MS + 1) } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.get()).toBeNull();
  });

  it("treats a missing timestamp as expired — never an unbounded grant", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.get()).toBeNull();
  });

  it("returns null when no entitlement is stored", async () => {
    installChrome();
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.get()).toBeNull();
  });

  it("returns null for a non-boolean entitled field", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: "yes", updatedAt: NOW } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.get()).toBeNull();
  });

  it("round-trips set→get within the TTL and stamps the write time", async () => {
    const { store } = installChrome();
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    await adapter.set(true);
    expect(store[STORAGE_KEY]).toEqual({ entitled: true, updatedAt: NOW });
    expect(await adapter.get()).toBe(true);
  });

  it("notifies subscribers when the stored entitlement changes", async () => {
    installChrome();
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    const seen: boolean[] = [];
    const unsubscribe = adapter.subscribe((entitled) => seen.push(entitled));
    await adapter.set(true);
    await adapter.set(false);
    unsubscribe();
    await adapter.set(true);
    expect(seen).toEqual([true, false]);
  });
});

describe("ChromeEntitlementAdapter — identity-bound record store (R7/R8)", () => {
  const NOW = 1_700_000_000_000;

  it("treats a stored-userId mismatch as no cache: user A's record is null under session user B", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true, userId: "user-a", updatedAt: NOW - 1000 } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.getRecord("user-b")).toBeNull();
  });

  it("returns the record to the same user within the TTL", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true, userId: "user-a", updatedAt: NOW - 1000 } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.getRecord("user-a")).toEqual({
      entitled: true,
      userId: "user-a",
      updatedAt: NOW - 1000,
    });
  });

  it("a legacy record without userId still reads under any session (Safari compatibility)", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true, updatedAt: NOW - 1000 } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.getRecord("user-b")).toEqual({ entitled: true, updatedAt: NOW - 1000 });
    expect(await adapter.getRecord()).toEqual({ entitled: true, updatedAt: NOW - 1000 });
    expect(await adapter.get()).toBe(true);
  });

  it("a session-less read (content-script shaped) still sees an identity-bound record", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true, userId: "user-a", updatedAt: NOW - 1000 } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.get()).toBe(true);
    expect((await adapter.getRecord())?.userId).toBe("user-a");
  });

  it("drops an expired record on record-level reads too (TTL preserved)", async () => {
    installChrome({
      [STORAGE_KEY]: { entitled: true, userId: "user-a", updatedAt: NOW - (ENTITLEMENT_CACHE_TTL_MS + 1) },
    });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.getRecord("user-a")).toBeNull();
  });

  it("a reconcile-shaped rewrite with unchanged entitled:true refreshes the TTL (R7)", async () => {
    installChrome();
    let now = NOW;
    const adapter = new ChromeEntitlementAdapter(() => now);
    await adapter.setRecord({ entitled: true, userId: "user-a", updatedAt: now });

    // Just before expiry, an always-online user's reconcile rewrites the same value…
    now = NOW + ENTITLEMENT_CACHE_TTL_MS - 1000;
    await adapter.setRecord({ entitled: true, userId: "user-a", updatedAt: now });

    // …so past the ORIGINAL write's TTL the cache is still honored (measured from the rewrite).
    now = NOW + ENTITLEMENT_CACHE_TTL_MS + 1000;
    expect(await adapter.getRecord("user-a")).toEqual({
      entitled: true,
      userId: "user-a",
      updatedAt: NOW + ENTITLEMENT_CACHE_TTL_MS - 1000,
    });
    expect(await adapter.get()).toBe(true);
  });

  it("an explicit entitled:false write notifies subscribers (teardown contract)", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true, userId: "user-a", updatedAt: NOW - 1000 } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    const seen: boolean[] = [];
    adapter.subscribe((entitled) => seen.push(entitled));
    await adapter.setRecord({ entitled: false, updatedAt: NOW });
    expect(seen).toEqual([false]);
    expect(await adapter.get()).toBe(false);
  });

  it("a boolean set() (Safari-pull shaped) replaces the record without carrying the old userId", async () => {
    const { store } = installChrome({ [STORAGE_KEY]: { entitled: true, userId: "user-a", updatedAt: NOW - 1000 } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    await adapter.set(true, NOW);
    expect(store[STORAGE_KEY]).toEqual({ entitled: true, updatedAt: NOW });
  });

  it("a garbage userId reads as an unbound record (defensive parse)", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true, userId: 42, updatedAt: NOW - 1000 } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.getRecord("user-b")).toEqual({ entitled: true, updatedAt: NOW - 1000 });
  });

  it("a non-finite timestamp is expired — never an unbounded grant", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true, updatedAt: Number.POSITIVE_INFINITY } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.get()).toBeNull();
    expect(await adapter.getRecord()).toBeNull();
  });
});
