import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type StillSettings } from "@still/shared-types";
import { TIKTOK_ROUTE, type TiktokCommittedSnapshot, type TiktokRouteReply, type TiktokRouteSender } from "@still/core/content/tiktok-blocked-route";
import { answerTiktokDocumentChallenges, TIKTOK_DOCUMENT_PORT, type TiktokDocumentPort } from "@still/core/content/tiktok-document-port";
import { createTikTokBlockedHost } from "@still/core/ui/v3/tiktok-blocked-host";
import { wireSafariTiktokHost, type SafariTiktokBrowser } from "./tiktok-host.js";

function event<T>() {
  const listeners = new Set<(value: T) => void>();
  return { addListener: (fn: (value: T) => void) => { listeners.add(fn); }, removeListener: (fn: (value: T) => void) => { listeners.delete(fn); }, emit: (value: T) => { for (const fn of [...listeners]) fn(value); } };
}
const ORIGIN = "safari-web-extension://still/", TIKTOK = "https://www.tiktok.com/@fixture/video/1";
function harness(withSession = true) {
  const session = new Map<string, unknown>(); const tabs = new Map<number, { id: number; url: string; documentId: string }>();
  const connect = event<TiktokDocumentPort>(), removed = event<number>();
  const replaced = new Set<(added: number, removed: number) => void>();
  type Listener = Parameters<SafariTiktokBrowser["runtime"]["onMessage"]["addListener"]>[0];
  const messages = new Set<Listener>(); let generation = 0;
  let nativeAvailable = true;
  let onUpdate: ((id: number, url: string) => Promise<unknown>) | undefined;
  let settings: StillSettings = { ...DEFAULT_SETTINGS, services: { ...DEFAULT_SETTINGS.services } };
  const area = { get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}), set: async (items: Record<string, unknown>) => { for (const [k,v] of Object.entries(items)) session.set(k,v); }, remove: async (key: string) => { session.delete(key); } };
  const native = (id = 7): TiktokRouteSender => { const tab = tabs.get(id)!; return { id: "still", url: tab.url, frameId: 0, documentId: tab.documentId, tab: { id } }; };
  const navigate = (id: number, url: string) => { tabs.set(id, { id, url, documentId: `native-${++generation}` }); };
  const browser: SafariTiktokBrowser = {
    runtime: { id: "still", getURL: (path) => ORIGIN+path, onConnect: connect, onMessage: { addListener: (fn) => { messages.add(fn); }, removeListener: (fn) => { messages.delete(fn); } } },
    storage: withSession ? { session: area } : {},
    tabs: { get: async (id) => { const tab=tabs.get(id); if (!tab) throw new Error("Missing tab"); return tab.url.startsWith(ORIGIN) ? { id } : { id, url: tab.url }; }, update: async (id, props) => { if (onUpdate) return onUpdate(id, props.url); navigate(id,props.url); return {}; }, onRemoved: removed, onReplaced: { addListener: (fn) => { replaced.add(fn); }, removeListener: (fn) => { replaced.delete(fn); } } },
  };
  const readCommitted = vi.fn(async (): Promise<TiktokCommittedSnapshot | null> => {
    if (!nativeAvailable) throw new Error("Native committed settings unavailable");
    return { settings, options: { pro: true } };
  });
  const create = () => wireSafariTiktokHost({ browser, randomId: () => crypto.randomUUID(), readCommitted });
  const send = (kind: string, sender = native(), extra = {}): Promise<TiktokRouteReply | "unhandled"> => new Promise((resolve) => {
    for (const fn of messages) if (fn({ kind, ...extra }, sender, resolve)) return;
    resolve("unhandled");
  });
  const bind = (sender = native()) => {
    const bgMessage = event<unknown>(), pageMessage = event<unknown>(), bgDisconnect = event<unknown>(), pageDisconnect = event<unknown>();
    let live = true;
    const disconnect = () => { if (!live) return; live=false; bgDisconnect.emit(null); pageDisconnect.emit(null); };
    const bg: TiktokDocumentPort = { name: TIKTOK_DOCUMENT_PORT, sender, onMessage: bgMessage, onDisconnect: bgDisconnect, postMessage: (m) => pageMessage.emit(m), disconnect };
    const page: TiktokDocumentPort = { name: TIKTOK_DOCUMENT_PORT, onMessage: pageMessage, onDisconnect: pageDisconnect, postMessage: (m) => bgMessage.emit(m), disconnect };
    const retire = answerTiktokDocumentChallenges(page); connect.emit(bg); return { retire, disconnect };
  };
  // Safari for Mac shows Still's page and TikTok in different web views and reports the swap as a
  // tab replacement: the same visible tab continues under a new id (tabs.onReplaced(added, removed)).
  const replace = (from: number, to: number) => {
    const tab = tabs.get(from)!; tabs.delete(from); tabs.set(to, { ...tab, id: to });
    for (const fn of [...replaced]) fn(to, from);
  };
  const replaceEvent = (to: number, from: number) => { for (const fn of [...replaced]) fn(to, from); };
  return { create, session, tabs, native, navigate, send, bind, removed, replace, replaceEvent, readCommitted, setUpdate: (fn: typeof onUpdate) => { onUpdate = fn; }, enable: () => { settings = structuredClone(DEFAULT_SETTINGS); }, disableMain: () => { settings = { ...settings, globalOn: false }; }, loseNative: () => { nativeAvailable=false; }, settings: () => settings, disable: () => { settings={...settings,services:{...settings.services,tiktok:false}}; } };
}
async function block(h: ReturnType<typeof harness>) {
  h.navigate(7,TIKTOK);
  expect(await h.send(TIKTOK_ROUTE.blocked)).toEqual({status:"redirected"});
  expect(h.tabs.get(7)!.url).toMatch(/^safari-web-extension:\/\/still\/tiktok-blocked.html\?r=/);
}
const grants = (h: ReturnType<typeof harness>) => [...h.session.keys()].filter((k) => k.startsWith("still:tiktok-tab:"));

describe("Safari D29 composition over existing route and confirmed living-tab authority", () => {
  it("genuinely requests, confirms, reads back and opens only the native current tab without settings writes", async () => {
    const h=harness(); const owner=h.create(); const before=structuredClone(h.settings()); await block(h); h.bind();
    expect(await h.send(TIKTOK_ROUTE.confirm)).toEqual({status:"failed"});
    expect(await h.send(TIKTOK_ROUTE.screen)).toEqual({status:"blocked",tab:7});
    expect(await h.send(TIKTOK_ROUTE.request)).toEqual({status:"confirming"});
    expect(grants(h)).toEqual([]);
    expect(await h.send(TIKTOK_ROUTE.confirm)).toEqual({status:"granted"});
    expect(await h.send(TIKTOK_ROUTE.open)).toEqual({status:"open",url:TIKTOK});
    h.navigate(7,TIKTOK); expect(await h.send(TIKTOK_ROUTE.blocked)).toEqual({status:"allowed"});
    h.navigate(8,TIKTOK); expect(await h.send(TIKTOK_ROUTE.blocked,h.native(8))).toEqual({status:"redirected"});
    expect(h.settings()).toEqual(before); await owner.stop();
  });
  it.each(["disconnect","new-document","new-connection","changed-setting"] as const)("%s during confirmation grants nothing", async (kind) => {
    const h=harness(); const owner=h.create(); await block(h); const connection=h.bind();
    expect(await h.send(TIKTOK_ROUTE.request)).toEqual({status:"confirming"});
    if (kind==="disconnect") connection.disconnect();
    else if (kind==="new-document") { h.navigate(7,h.tabs.get(7)!.url); h.bind(); }
    else if (kind==="new-connection") h.bind(); else h.disable();
    expect(await h.send(TIKTOK_ROUTE.confirm)).toEqual({status:"failed"});
    expect(grants(h)).toEqual([]); await owner.stop();
  });
  it("missing native document identity or browser session storage holds the action", async () => {
    const h=harness(); const owner=h.create(); await block(h); h.bind({...h.native(),documentId:undefined});
    expect(await h.send(TIKTOK_ROUTE.screen,{...h.native(),documentId:undefined})).toEqual({status:"unavailable",tab:7});
    expect(grants(h)).toEqual([]); await owner.stop();
    const absent=harness(false); const held=absent.create(); absent.navigate(7,TIKTOK);
    expect(await absent.send(TIKTOK_ROUTE.blocked)).toEqual({status:"held"}); expect(absent.session.size).toBe(0); await held.stop();
  });
  it("foreign, content and subframe connections and forged target bodies cannot confirm", async () => {
    const h=harness(); const owner=h.create(); await block(h);
    for (const sender of [{...h.native(),id:"foreign"},{...h.native(),frameId:1},{...h.native(),url:TIKTOK}]) {
      h.bind(sender); expect(await h.send(TIKTOK_ROUTE.request)).toEqual({status:"failed"});
    }
    h.bind(); expect(await h.send(TIKTOK_ROUTE.request,h.native(),{url:TIKTOK,tabId:7})).toBe("unhandled");
    expect(grants(h)).toEqual([]); await owner.stop();
  });
  it("native committed authority failure during confirmation grants nothing", async () => {
    const h=harness(); const owner=h.create(); await block(h); h.bind();
    expect(await h.send(TIKTOK_ROUTE.request)).toEqual({status:"confirming"}); h.loseNative();
    expect(await h.send(TIKTOK_ROUTE.confirm)).toEqual({status:"failed"});
    expect(grants(h)).toEqual([]); await owner.stop();
  });
  it("worker wake retains only a completed living-tab grant; session restart and tab close remove it", async () => {
    const h=harness(); let owner=h.create(); await block(h); h.bind();
    await h.send(TIKTOK_ROUTE.request); expect(await h.send(TIKTOK_ROUTE.confirm)).toEqual({status:"granted"});
    await h.send(TIKTOK_ROUTE.open); h.navigate(7,TIKTOK); await owner.stop(); owner=h.create();
    expect(await h.send(TIKTOK_ROUTE.blocked)).toEqual({status:"allowed"});
    h.session.clear(); expect(await h.send(TIKTOK_ROUTE.blocked)).toEqual({status:"redirected"});
    h.bind(); await h.send(TIKTOK_ROUTE.request); await h.send(TIKTOK_ROUTE.confirm);
    h.tabs.delete(7); h.removed.emit(7); for(let i=0;i<30;i++) await Promise.resolve();
    expect(grants(h)).toEqual([]); await owner.stop();
  });
});


describe("saved Off on a freshly reloaded Safari blocked page", () => {
  function pageHost(h: ReturnType<typeof harness>, sender = h.native()) {
    const navigate = vi.fn((url: string) => h.navigate(7, url));
    const host = createTikTokBlockedHost({
      send: ({ kind }) => h.send(kind, sender), navigate, openSettings: vi.fn(),
      request: new URL(sender.url!).searchParams.get("r")!, document: sender.documentId!,
    });
    return { host, navigate };
  }

  it.each(["tiktok", "main"] as const)("%s Off reload opens the original URL with no allowance or settings write, and On blocks again", async (control) => {
    const h = harness(); const owner = h.create(); await block(h);
    const old = h.bind();
    if (control === "tiktok") h.disable(); else h.disableMain();
    const saved = structuredClone(h.settings());
    old.disconnect(); h.navigate(7, h.tabs.get(7)!.url); h.bind();
    const p = pageHost(h); await p.host.start();
    expect(p.navigate).toHaveBeenCalledExactlyOnceWith(TIKTOK);
    expect(h.tabs.get(7)!.url).toBe(TIKTOK);
    expect(grants(h)).toEqual([]);
    expect(h.settings()).toEqual(saved);
    h.enable();
    expect(await h.send(TIKTOK_ROUTE.blocked)).toEqual({ status: "redirected" });
    expect(grants(h)).toEqual([]);
    p.host.stop(); await owner.stop();
  });

  it("On remains blocked after a fresh reload and still requires confirmation", async () => {
    const h = harness(); const owner = h.create(); await block(h); h.bind();
    const p = pageHost(h); await p.host.start();
    expect(p.host.state().phase).toBe("blocked");
    expect(p.navigate).not.toHaveBeenCalled();
    expect(grants(h)).toEqual([]);
    p.host.stop(); await owner.stop();
  });

  it.each(["unreadable", "missing"] as const)("%s committed authority cannot release an Off page", async (failure) => {
    const h = harness(); const owner = h.create(); await block(h); h.bind(); h.disable();
    if (failure === "unreadable") h.loseNative();
    else h.readCommitted.mockResolvedValueOnce(null);
    const p = pageHost(h); await p.host.start();
    expect(p.navigate).not.toHaveBeenCalled();
    expect(grants(h)).toEqual([]);
    p.host.stop(); await owner.stop();
  });

  it("a disconnected blocked page cannot use committed Off to navigate", async () => {
    const h = harness(); const owner = h.create(); await block(h);
    const connection = h.bind(); h.disable(); connection.disconnect();
    const p = pageHost(h); await p.host.start();
    expect(p.navigate).not.toHaveBeenCalled();
    expect(grants(h)).toEqual([]);
    p.host.stop(); await owner.stop();
  });

  it.each(["new-document", "new-connection", "moved-tab", "unbound-target", "foreign-target"] as const)("%s cannot release the old page while committed Off is being read", async (change) => {
    const h = harness(); const owner = h.create(); await block(h); h.bind(); h.disable();
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      h.readCommitted.mockImplementationOnce(async () => {
        resolve(); await new Promise<void>((done) => { release = done; });
        return { settings: h.settings(), options: { pro: true } };
      });
    });
    const p = pageHost(h); const started = p.host.start(); await entered;
    if (change === "new-document") { h.navigate(7, h.tabs.get(7)!.url); h.bind(); }
    else if (change === "new-connection") h.bind();
    else if (change === "moved-tab") h.navigate(7, "https://example.com/");
    else if (change === "unbound-target") h.session.delete("still:tiktok-origin:7");
    else {
      const bound = h.session.get("still:tiktok-origin:7") as { request: string };
      h.session.set("still:tiktok-origin:7", { ...bound, target: "https://example.com/" });
    }
    release(); await started;
    expect(p.navigate).not.toHaveBeenCalled();
    expect(grants(h)).toEqual([]);
    p.host.stop(); await owner.stop();
  });
});


describe("Safari for Mac replaces the tab when it swaps between TikTok and Still's page", () => {
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  async function blockAndSwap(h: ReturnType<typeof harness>) {
    await block(h);
    h.replace(7, 8); await settle();
  }

  it("the replaced blocked page opens the confirmation, confirm grants this tab only, and TikTok opens after the next swap", async () => {
    const h = harness(); const owner = h.create(); const before = structuredClone(h.settings());
    await blockAndSwap(h); h.bind(h.native(8));
    expect(await h.send(TIKTOK_ROUTE.screen, h.native(8))).toEqual({ status: "blocked", tab: 8 });
    expect(await h.send(TIKTOK_ROUTE.request, h.native(8))).toEqual({ status: "confirming" });
    expect(await h.send(TIKTOK_ROUTE.confirm, h.native(8))).toEqual({ status: "granted" });
    expect(await h.send(TIKTOK_ROUTE.open, h.native(8))).toEqual({ status: "open", url: TIKTOK });
    h.navigate(8, TIKTOK); h.replace(8, 9); await settle();
    expect(await h.send(TIKTOK_ROUTE.blocked, h.native(9))).toEqual({ status: "allowed" });
    h.navigate(10, TIKTOK); expect(await h.send(TIKTOK_ROUTE.blocked, h.native(10))).toEqual({ status: "redirected" });
    expect(grants(h)).toEqual(["still:tiktok-tab:9"]);
    expect(h.settings()).toEqual(before); await owner.stop();
  });

  it.each(["tiktok", "main"] as const)("%s Off + reload of the replaced blocked page returns to the original TikTok URL", async (control) => {
    const h = harness(); const owner = h.create(); await blockAndSwap(h);
    const first = h.bind(h.native(8));
    if (control === "tiktok") h.disable(); else h.disableMain();
    const saved = structuredClone(h.settings());
    first.disconnect(); h.navigate(8, h.tabs.get(8)!.url); h.bind(h.native(8));
    expect(await h.send(TIKTOK_ROUTE.screen, h.native(8))).toEqual({ status: "open", url: TIKTOK });
    expect(grants(h)).toEqual([]); expect(h.settings()).toEqual(saved); await owner.stop();
  });

  it("closing the replaced tab still ends a carried allowance", async () => {
    const h = harness(); const owner = h.create(); await blockAndSwap(h); h.bind(h.native(8));
    await h.send(TIKTOK_ROUTE.request, h.native(8)); await h.send(TIKTOK_ROUTE.confirm, h.native(8));
    h.navigate(8, TIKTOK); h.replace(8, 9); await settle();
    h.tabs.delete(9); h.removed.emit(9); await settle();
    expect(grants(h)).toEqual([]); await owner.stop();
  });

  it("a replacement never overwrites a newer redirect already saved for the new tab", async () => {
    const h = harness(); const owner = h.create(); await block(h);
    h.navigate(8, TIKTOK); expect(await h.send(TIKTOK_ROUTE.blocked, h.native(8))).toEqual({ status: "redirected" });
    const newer = h.session.get("still:tiktok-origin:8");
    h.replace(7, 8); await settle();
    expect(h.session.get("still:tiktok-origin:8")).toEqual(newer);
    expect(h.session.has("still:tiktok-origin:7")).toBe(false); await owner.stop();
  });

  it("answers arriving straight after the replacement wait for the moved address and the carried allowance", async () => {
    const h = harness(); const owner = h.create(); await block(h);
    h.replace(7, 8); h.bind(h.native(8));
    expect(await h.send(TIKTOK_ROUTE.screen, h.native(8))).toEqual({ status: "blocked", tab: 8 });
    expect(await h.send(TIKTOK_ROUTE.request, h.native(8))).toEqual({ status: "confirming" });
    expect(await h.send(TIKTOK_ROUTE.confirm, h.native(8))).toEqual({ status: "granted" });
    expect(await h.send(TIKTOK_ROUTE.open, h.native(8))).toEqual({ status: "open", url: TIKTOK });
    h.navigate(8, TIKTOK); h.replace(8, 9);
    expect(await h.send(TIKTOK_ROUTE.blocked, h.native(9))).toEqual({ status: "allowed" });
    await owner.stop();
  });

  it("an unfinished confirmation is never carried to the replacement", async () => {
    const h = harness(); const owner = h.create(); await blockAndSwap(h); h.bind(h.native(8));
    expect(await h.send(TIKTOK_ROUTE.request, h.native(8))).toEqual({ status: "confirming" });
    h.replace(8, 9); await settle(); h.bind(h.native(9));
    expect(await h.send(TIKTOK_ROUTE.confirm, h.native(9))).toEqual({ status: "failed" });
    expect(grants(h)).toEqual([]);
    h.navigate(9, TIKTOK); expect(await h.send(TIKTOK_ROUTE.blocked, h.native(9))).toEqual({ status: "redirected" });
    await owner.stop();
  });

  it("a redirect whose tab is replaced while the update is still answering keeps its address", async () => {
    const h = harness(); const owner = h.create(); h.navigate(7, TIKTOK);
    h.setUpdate(async (id, url) => { h.navigate(id, url); h.replace(7, 8); throw new Error("Tab 7 was replaced"); });
    expect(await h.send(TIKTOK_ROUTE.blocked)).toEqual({ status: "held" });
    h.setUpdate(undefined); await settle(); h.bind(h.native(8));
    expect(await h.send(TIKTOK_ROUTE.screen, h.native(8))).toEqual({ status: "blocked", tab: 8 });
    await owner.stop();
  });

  it("asking again for the same address keeps the same request, so a slow first swap still finds its record", async () => {
    const h = harness(); const owner = h.create(); await block(h);
    const first = h.tabs.get(7)!.url;
    h.navigate(7, TIKTOK); expect(await h.send(TIKTOK_ROUTE.blocked)).toEqual({ status: "redirected" });
    expect(h.tabs.get(7)!.url).toBe(first);
    await owner.stop();
  });

  it("TikTok's first message can arrive just before Safari reports the replacement and is still allowed", async () => {
    const h = harness(); const owner = h.create(); await blockAndSwap(h); h.bind(h.native(8));
    await h.send(TIKTOK_ROUTE.request, h.native(8)); await h.send(TIKTOK_ROUTE.confirm, h.native(8));
    expect(await h.send(TIKTOK_ROUTE.open, h.native(8))).toEqual({ status: "open", url: TIKTOK });
    h.navigate(9, TIKTOK);
    const asked = h.send(TIKTOK_ROUTE.blocked, h.native(9));
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.tabs.delete(8); h.replaceEvent(9, 8);
    expect(await asked).toEqual({ status: "allowed" });
    await owner.stop();
  });

  it("a newer TikTok address in the replacement tab wins over the moved older record", async () => {
    const h = harness(); const owner = h.create(); await block(h);
    h.replace(7, 8);
    h.navigate(8, "https://www.tiktok.com/@other");
    expect(await h.send(TIKTOK_ROUTE.blocked, h.native(8))).toEqual({ status: "redirected" });
    expect((h.session.get("still:tiktok-origin:8") as { target: string }).target).toBe("https://www.tiktok.com/@other");
    await owner.stop();
  });

  it("back-to-back replacements still carry a completed allowance to the last tab", async () => {
    const h = harness(); const owner = h.create(); await blockAndSwap(h); h.bind(h.native(8));
    await h.send(TIKTOK_ROUTE.request, h.native(8)); await h.send(TIKTOK_ROUTE.confirm, h.native(8));
    h.navigate(8, TIKTOK); h.replace(8, 9); h.replace(9, 10);
    expect(await h.send(TIKTOK_ROUTE.blocked, h.native(10))).toEqual({ status: "allowed" });
    expect(grants(h)).toEqual(["still:tiktok-tab:10"]);
    await owner.stop();
  });
});
