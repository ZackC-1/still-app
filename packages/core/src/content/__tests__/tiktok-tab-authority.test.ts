import { afterEach, describe, expect, it, vi } from "vitest";
import { createTiktokTabAuthority } from "../tiktok-tab-authority.js";
import {
  ruleSet,
  on,
  access,
  capabilities,
} from "../../rules/__tests__/format2-fixtures.js";

const target = "https://www.tiktok.com/@fixture/video/123?chosen=yes#details";
const context = { tabId: 7, frameId: 0, target };
const owners: ReturnType<typeof createTiktokTabAuthority>[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.stop()));
});

function host() {
  const records = new Map<number, unknown>();
  const living = new Set([7, 8]);
  let settings = on;
  const confirm = vi.fn(async () => true);
  const store = {
    get: vi.fn(async (id: number) => records.get(id)),
    set: vi.fn(async (id: number, value: true) => {
      records.set(id, value);
    }),
    remove: vi.fn(async (id: number) => {
      records.delete(id);
    }),
  };
  const readCommitted = vi.fn(async () => ({
    settings,
    options: { access, capabilities },
  }));
  function create(withConfirmation = true) {
    const owner = createTiktokTabAuthority({
      ruleSet,
      store,
      readCommitted,
      isLivingTab: async (id) => living.has(id),
      confirm: withConfirmation ? confirm : undefined,
    });
    owners.push(owner);
    return owner;
  }
  return {
    records,
    living,
    store,
    confirm,
    create,
    readCommitted,
    off: () => {
      settings = { ...on, services: { ...on.services, tiktok: false } };
    },
  };
}

describe("one living top-level TikTok tab authority", () => {
  it("holds without verified confirmation; a boolean in caller data is not confirmation", async () => {
    const h = host();
    const owner = h.create(false);
    const forged = { ...context, isTrusted: true };
    expect(await owner.allow(forged)).toBe(false);
    expect(await owner.isAllowed(context)).toBe(false);
    expect(h.records.size).toBe(0);
  });
  it("persists only the confirmed tab boolean and survives owner reopen and same-tab destination changes", async () => {
    const h = host();
    const owner = h.create();
    expect(await owner.allow(context)).toBe(true);
    expect([...h.records]).toEqual([[7, true]]);
    expect(
      await owner.isAllowed({ ...context, target: "https://m.tiktok.com/" }),
    ).toBe(true);
    expect(
      await owner.isAllowed({ ...context, target: "https://example.com/" }),
    ).toBe(false);
    expect(await owner.isAllowed(context)).toBe(true);
    await owner.stop();
    expect(await h.create(false).isAllowed(context)).toBe(true);
  });
  it("does not transfer a grant to new, duplicated, reopened or restored tab IDs or an embed", async () => {
    const h = host();
    const owner = h.create();
    expect(await owner.allow(context)).toBe(true);
    for (const tabId of [8, 9, 10, 11])
      expect(await owner.isAllowed({ ...context, tabId })).toBe(false);
    expect(await owner.isAllowed({ ...context, frameId: 1 })).toBe(false);
    expect(await owner.allow({ ...context, frameId: 1 })).toBe(false);
  });
  it.each([
    "https://tiktok.com.example.com/",
    "https://www.youtube.com/",
    "javascript:alert(1)",
    "https://user:secret@www.tiktok.com/",
  ])("rejects invalid/unsupported original target %s", async (url) => {
    const h = host();
    const owner = h.create();
    expect(await owner.allow({ ...context, target: url })).toBe(false);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.records.size).toBe(0);
  });
  it("checks the current committed effective decision after confirmation and after persistence", async () => {
    const h = host();
    const owner = h.create();
    h.confirm.mockImplementationOnce(async () => {
      h.off();
      return true;
    });
    expect(await owner.allow(context)).toBe(false);
    expect(h.records.size).toBe(0);
  });
  it("cancellation, failed confirmation and unavailable committed reads never create permission", async () => {
    const h = host();
    const owner = h.create();
    h.confirm.mockResolvedValueOnce(false);
    expect(await owner.allow(context)).toBe(false);
    h.confirm.mockRejectedValueOnce(new Error("unavailable"));
    expect(await owner.allow(context)).toBe(false);
    h.readCommitted.mockRejectedValueOnce(new Error("unavailable"));
    expect(await owner.allow(context)).toBe(false);
    expect(h.records.size).toBe(0);
  });
  it("an Off committed during persistence removes the provisional grant before returning", async () => {
    const h = host();
    const owner = h.create();
    h.store.set.mockImplementationOnce(async (id, value) => {
      h.records.set(id, value);
      h.off();
    });
    expect(await owner.allow(context)).toBe(false);
    expect(h.records.size).toBe(0);
    expect(await h.create(false).isAllowed(context)).toBe(false);
  });
  it("failed or lost persistence does not publish permission", async () => {
    const h = host();
    const owner = h.create();
    h.store.set.mockRejectedValueOnce(new Error("write unavailable"));
    expect(await owner.allow(context)).toBe(false);
    expect(await owner.isAllowed(context)).toBe(false);
    h.store.set.mockImplementationOnce(async () => {});
    expect(await owner.allow(context)).toBe(false);
    expect(h.records.size).toBe(0);
  });
  it("close during delayed persistence fences completion and same-ID reuse, then removes the record", async () => {
    const h = host();
    const owner = h.create();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writing!: () => void;
    const entered = new Promise<void>((resolve) => {
      writing = resolve;
    });
    h.store.set.mockImplementationOnce(async (id, value) => {
      writing();
      await gate;
      h.records.set(id, value);
    });
    const pending = owner.allow(context);
    await entered;
    h.living.delete(7);
    const closed = owner.closeTab(7);
    h.living.add(7); // Deliberately stronger than Chrome's session-unique-ID guarantee.
    release();
    expect(await pending).toBe(false);
    await closed;
    expect(await owner.isAllowed(context)).toBe(false);
    expect(h.records.size).toBe(0);
  });
  it("stop during delayed persistence fences completion and drains cleanup before a new owner", async () => {
    const h = host();
    const owner = h.create();
    let release!: () => void;
    let writing!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      writing = resolve;
    });
    h.store.set.mockImplementationOnce(async (id, value) => {
      writing();
      await gate;
      h.records.set(id, value);
    });
    const pending = owner.allow(context);
    await entered;
    const stopping = owner.stop();
    release();
    expect(await pending).toBe(false);
    await stopping;
    expect(await h.create(false).isAllowed(context)).toBe(false);
    expect(h.records.size).toBe(0);
  });
  it("serializes same-tab commits and a missing/failed session read denies an otherwise living tab", async () => {
    const h = host();
    const owner = h.create();
    expect(
      await Promise.all([owner.allow(context), owner.allow(context)]),
    ).toEqual([true, true]);
    expect([...h.records]).toEqual([[7, true]]);
    h.store.get.mockRejectedValueOnce(new Error("read unavailable"));
    expect(await owner.isAllowed(context)).toBe(false);
    h.records.clear(); // browser-session loss/restart, not a saved-choice mutation.
    expect(await h.create(false).isAllowed(context)).toBe(false);
  });
});
