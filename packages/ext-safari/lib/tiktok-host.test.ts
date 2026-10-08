import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type StillSettings } from "@still/shared-types";
import { TIKTOK_ROUTE, type TiktokRouteReply, type TiktokRouteSender } from "@still/core/content/tiktok-blocked-route";
import { answerTiktokDocumentChallenges, TIKTOK_DOCUMENT_PORT, type TiktokDocumentPort } from "@still/core/content/tiktok-document-port";
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
  let settings: StillSettings = { ...DEFAULT_SETTINGS, services: { ...DEFAULT_SETTINGS.services } };
  const area = { get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}), set: async (items: Record<string, unknown>) => { for (const [k,v] of Object.entries(items)) session.set(k,v); }, remove: async (key: string) => { session.delete(key); } };
  const native = (id = 7): TiktokRouteSender => { const tab = tabs.get(id)!; return { id: "still", url: tab.url, frameId: 0, documentId: tab.documentId, tab: { id } }; };
  const navigate = (id: number, url: string) => { tabs.set(id, { id, url, documentId: `native-${++generation}` }); };
  const browser: SafariTiktokBrowser = {
    runtime: { id: "still", getURL: (path) => ORIGIN+path, onConnect: connect, onMessage: { addListener: (fn) => { messages.add(fn); }, removeListener: (fn) => { messages.delete(fn); } } },
    storage: withSession ? { session: area } : {},
    tabs: { get: async (id) => { const tab=tabs.get(id); if (!tab) throw new Error("Missing tab"); return tab.url.startsWith(ORIGIN) ? { id } : { id, url: tab.url }; }, update: async (id, props) => { navigate(id,props.url); return {}; }, onRemoved: removed, onReplaced: { addListener: (fn) => { replaced.add(fn); }, removeListener: (fn) => { replaced.delete(fn); } } },
  };
  const create = () => wireSafariTiktokHost({ browser, randomId: () => crypto.randomUUID(), readCommitted: async () => {
    if (!nativeAvailable) throw new Error("Native committed settings unavailable");
    return { settings, options: { pro: true } };
  } });
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
  return { create, session, tabs, native, navigate, send, bind, removed, loseNative: () => { nativeAvailable=false; }, settings: () => settings, disable: () => { settings={...settings,services:{...settings.services,tiktok:false}}; } };
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
