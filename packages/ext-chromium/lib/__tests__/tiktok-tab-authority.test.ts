import { describe, expect, it, vi } from "vitest";
import {
  createChromeTiktokTabAuthority,
  type TiktokTabBrowser,
} from "../tiktok-tab-authority.js";
import {
  ruleSet,
  on,
  access,
  capabilities,
} from "../../../core/src/rules/__tests__/format2-fixtures.js";

const target = "https://www.tiktok.com/@fixture/video/123";
const screen = "chrome-extension://still/synthetic-blocked.html?fixture=only";
const sender = {
  id: "still",
  url: screen,
  frameId: 0,
  documentId: "document-7",
  tab: { id: 7 },
};

function host() {
  const session = new Map<string, unknown>();
  const tabs = new Map<number, { id: number; url: string }>([
    [7, { id: 7, url: screen }],
  ]);
  const removed = new Set<(id: number) => void>();
  const replaced = new Set<(added: number, removed: number) => void>();
  const sessionArea = {
    get: vi.fn(async (key: string) => ({ [key]: session.get(key) })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) session.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      session.delete(key);
    }),
  };
  const contexts = vi.fn(async () =>
    [...tabs.values()].map((tab) => ({
      contextType: "TAB" as const,
      documentId: `document-${tab.id}`,
      tabId: tab.id,
      frameId: 0,
      documentUrl: tab.url,
    })),
  );
  const browser = {
    runtime: {
      id: "still",
      getContexts: contexts,
      getURL: (path: string) => `chrome-extension://still/${path}`,
    },
    storage: { session: sessionArea },
    tabs: {
      get: async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error("closed");
        return { ...tab };
      },
      onRemoved: {
        addListener: (fn: (id: number) => void) => {
          removed.add(fn);
        },
        removeListener: (fn: (id: number) => void) => {
          removed.delete(fn);
        },
      },
      onReplaced: {
        addListener: (fn: (added: number, removed: number) => void) => {
          replaced.add(fn);
        },
        removeListener: (fn: (added: number, removed: number) => void) => {
          replaced.delete(fn);
        },
      },
    },
  };
  const checkedBrowser: TiktokTabBrowser = browser;
  const confirmation = vi.fn(async () => true);
  function create(
    verified = true,
    actualBrowser: TiktokTabBrowser = checkedBrowser,
  ) {
    return createChromeTiktokTabAuthority({
      browser: actualBrowser,
      ruleSet,
      readCommitted: async () => ({
        settings: on,
        options: { access, capabilities },
      }),
      blockedPagePath: verified ? "synthetic-blocked.html" : undefined,
      resolveOriginalTarget: verified ? async () => target : undefined,
      confirm: verified ? confirmation : undefined,
    });
  }
  const page = (id = 7, frameId = 0) => ({
    id: "still",
    url: target,
    frameId,
    tab: { id },
  });
  return {
    session,
    sessionArea,
    tabs,
    removed,
    replaced,
    browser,
    contexts,
    confirmation,
    create,
    page,
  };
}

describe("dormant Chromium browser-session TikTok adapter", () => {
  it("default missing trusted route/original target/confirmation holds without any grant", async () => {
    const h = host();
    const owner = h.create(false);
    expect(await owner.allow(sender)).toBe(false);
    expect(h.session.size).toBe(0);
    expect(h.confirmation).not.toHaveBeenCalled();
    await owner.stop();
  });
  it("uses session only, the actual sender tab and original host target; survives owner reopen until session loss", async () => {
    const h = host();
    const owner = h.create();
    expect(await owner.allow(sender)).toBe(true);
    expect([...h.session.values()]).toEqual([true]);
    expect([...h.session.keys()]).toEqual(["still:tiktok-tab:7"]);
    h.tabs.set(7, { id: 7, url: target });
    expect(await owner.isAllowed(h.page())).toBe(true);
    h.tabs.set(7, { id: 7, url: "https://example.com/" });
    h.tabs.set(7, { id: 7, url: target });
    expect(await owner.isAllowed(h.page())).toBe(true);
    await owner.stop();
    expect(h.removed.size).toBe(0);
    expect(h.replaced.size).toBe(0);
    const reopened = h.create(false);
    expect(await reopened.isAllowed(h.page())).toBe(true);
    h.session.clear();
    expect(await reopened.isAllowed(h.page())).toBe(false);
    await reopened.stop();
  });
  it.each([
    { ...sender, id: "other" },
    { ...sender, frameId: 1 },
    { ...sender, frameId: undefined },
    { ...sender, url: target },
    { ...sender, url: "chrome-extension://still.evil/synthetic-blocked.html" },
    { ...sender, url: "chrome-extension://still/options.html" },
    { ...sender, tab: { id: -1 } },
  ])(
    "rejects forged/iframe/other-route browser metadata before confirmation %#",
    async (untrusted) => {
      const h = host();
      const owner = h.create();
      expect(await owner.allow(untrusted)).toBe(false);
      expect(h.confirmation).not.toHaveBeenCalled();
      expect(h.session.size).toBe(0);
      await owner.stop();
    },
  );
  it("does not use caller body fields to choose a tab, destination or trust decision", async () => {
    const h = host();
    const owner = h.create(false);
    const forged = {
      ...sender,
      isTrusted: true,
      target,
      tabId: 7,
      confirmed: true,
    };
    expect(await owner.allow(forged)).toBe(false);
    expect(h.session.size).toBe(0);
    await owner.stop();
  });
  it("a living extension options page cannot mint permission through the blocked-page confirmation port", async () => {
    const h = host();
    const owner = h.create();
    const url = "chrome-extension://still/options.html";
    h.tabs.set(7, { id: 7, url });
    expect(await owner.allow({ ...sender, url })).toBe(false);
    expect(h.confirmation).not.toHaveBeenCalled();
    expect(h.session.size).toBe(0);
    await owner.stop();
  });
  it("validates the active native extension document when tabs.get redacts its URL", async () => {
    const h = host();
    const redacted = {
      ...h.browser,
      tabs: { ...h.browser.tabs, get: async (id: number) => ({ id }) },
    };
    const owner = h.create(true, redacted);
    expect(await owner.allow(sender)).toBe(true);
    expect(h.contexts).toHaveBeenCalledWith({
      documentIds: ["document-7"],
      tabIds: [7],
      frameIds: [0],
      contextTypes: ["TAB"],
    });
    expect(h.session.size).toBe(1);
    await owner.stop();
  });
  it("a replaced same-URL document cannot complete the old document's confirmation", async () => {
    const h = host();
    const owner = h.create();
    h.confirmation.mockImplementationOnce(async () => {
      h.contexts.mockResolvedValue([
        {
          contextType: "TAB",
          documentId: "replacement",
          tabId: 7,
          frameId: 0,
          documentUrl: screen,
        },
      ]);
      return true;
    });
    expect(await owner.allow(sender)).toBe(false);
    expect(h.session.size).toBe(0);
    await owner.stop();
  });
  it("missing native document/context capability or mismatched context holds only the allowance", async () => {
    const h = host();
    for (const context of [
      [],
      [
        {
          contextType: "TAB" as const,
          documentId: "other",
          tabId: 7,
          frameId: 0,
          documentUrl: screen,
        },
      ],
      [
        {
          contextType: "TAB" as const,
          documentId: "document-7",
          tabId: 8,
          frameId: 0,
          documentUrl: screen,
        },
      ],
      [
        {
          contextType: "TAB" as const,
          documentId: "document-7",
          tabId: 7,
          frameId: 1,
          documentUrl: screen,
        },
      ],
      [
        {
          contextType: "TAB" as const,
          documentId: "document-7",
          tabId: 7,
          frameId: 0,
          documentUrl: "chrome-extension://still/options.html",
        },
      ],
    ]) {
      h.contexts.mockResolvedValue(context);
      const owner = h.create();
      expect(await owner.allow(sender)).toBe(false);
      await owner.stop();
    }
    const missing = h.create(true, {
      ...h.browser,
      runtime: { id: "still", getURL: h.browser.runtime.getURL },
    });
    expect(await missing.allow(sender)).toBe(false);
    await missing.stop();
    h.contexts.mockResolvedValue([
      {
        contextType: "TAB",
        documentId: "document-7",
        tabId: 7,
        frameId: 0,
        documentUrl: screen,
      },
    ]);
    const owner = h.create();
    expect(await owner.allow({ ...sender, documentId: undefined })).toBe(false);
    expect(h.session.size).toBe(0);
    await owner.stop();
  });
  it("denies duplicate/new/restored/reopened IDs and all embedded frames", async () => {
    const h = host();
    const owner = h.create();
    expect(await owner.allow(sender)).toBe(true);
    h.tabs.set(7, { id: 7, url: target });
    for (const id of [8, 9, 10, 11]) {
      h.tabs.set(id, { id, url: target });
      expect(await owner.isAllowed(h.page(id))).toBe(false);
    }
    expect(await owner.isAllowed(h.page(7, 1))).toBe(false);
    expect(await owner.isAllowed(h.page())).toBe(true);
    await owner.stop();
  });
  it("close and replacement events invalidate old IDs without copying permission to a new one", async () => {
    const h = host();
    const owner = h.create();
    expect(await owner.allow(sender)).toBe(true);
    h.tabs.delete(7);
    for (const listener of h.removed) listener(7);
    await owner.stop();
    expect(h.session.size).toBe(0);
    h.tabs.set(8, { id: 8, url: screen });
    const next = h.create();
    expect(
      await next.allow({ ...sender, documentId: "document-8", tab: { id: 8 } }),
    ).toBe(true);
    for (const listener of h.replaced) listener(9, 8);
    h.tabs.delete(8);
    h.tabs.set(9, { id: 9, url: target });
    expect(await next.isAllowed(h.page(9))).toBe(false);
    await next.stop();
    expect(h.session.size).toBe(0);
  });
  it("a changed/closed actual tab during confirmation cannot grant a stale sender", async () => {
    const h = host();
    const owner = h.create();
    h.confirmation.mockImplementationOnce(async () => {
      h.tabs.set(7, { id: 7, url: target });
      return true;
    });
    expect(await owner.allow(sender)).toBe(false);
    expect(h.session.size).toBe(0);
    await owner.stop();
  });
  it("unsupported session or lifecycle capability is an affected action hold", async () => {
    const h = host();
    for (const browser of [
      { ...h.browser, storage: {} },
      { ...h.browser, tabs: undefined },
    ]) {
      const owner = h.create(true, browser);
      expect(owner.supported).toBe(false);
      expect(await owner.allow(sender)).toBe(false);
      expect(await owner.isAllowed(h.page())).toBe(false);
      await owner.stop();
    }
    expect(h.session.size).toBe(0);
  });
  it("session read/write failures and cancelled genuine-host confirmation remain denied", async () => {
    const h = host();
    const owner = h.create();
    h.sessionArea.get.mockRejectedValueOnce(new Error("read failed"));
    expect(await owner.allow(sender)).toBe(false);
    h.sessionArea.set.mockRejectedValueOnce(new Error("write failed"));
    expect(await owner.allow(sender)).toBe(false);
    h.confirmation.mockResolvedValueOnce(false);
    expect(await owner.allow(sender)).toBe(false);
    expect(h.session.size).toBe(0);
    await owner.stop();
  });
});
