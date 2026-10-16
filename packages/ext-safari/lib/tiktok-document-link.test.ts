import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { TIKTOK_ROUTE, type TiktokRouteReply, type TiktokRouteSender } from "@still/core/content/tiktok-blocked-route";
import { TIKTOK_DOCUMENT_PORT, type TiktokDocumentPort } from "@still/core/content/tiktok-document-port";
import { createTiktokDocumentLink } from "./tiktok-document-link.js";
import { wireSafariTiktokHost, type SafariTiktokBrowser } from "./tiktok-host.js";

function event<T>() {
  const listeners = new Set<(value: T) => void>();
  return { addListener: (fn: (value: T) => void) => { listeners.add(fn); }, removeListener: (fn: (value: T) => void) => { listeners.delete(fn); }, emit: (value: T) => { for (const fn of [...listeners]) fn(value); } };
}
const ORIGIN = "safari-web-extension://still/", TIKTOK = "https://www.tiktok.com/@fixture/video/1";
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

/** The real Safari background composition, with a browser that can drop every page port (unload). */
function background() {
  const session = new Map<string, unknown>(); const tabs = new Map<number, string>();
  const connect = event<TiktokDocumentPort>();
  type Listener = Parameters<SafariTiktokBrowser["runtime"]["onMessage"]["addListener"]>[0];
  const messages = new Set<Listener>();
  const live = new Set<() => void>();
  const browser: SafariTiktokBrowser = {
    runtime: { id: "still", getURL: (path) => ORIGIN + path, onConnect: connect, onMessage: { addListener: (fn) => { messages.add(fn); }, removeListener: (fn) => { messages.delete(fn); } } },
    storage: { session: { get: async (key) => (session.has(key) ? { [key]: session.get(key) } : {}), set: async (items) => { for (const [k, v] of Object.entries(items)) session.set(k, v); }, remove: async (key) => { session.delete(key); } } },
    tabs: { get: async (id) => { const url = tabs.get(id); if (!url) throw new Error("Missing tab"); return url.startsWith(ORIGIN) ? { id } : { id, url }; }, update: async (id, props) => { tabs.set(id, props.url); return {}; }, onRemoved: event<number>(), onReplaced: { addListener: () => {}, removeListener: () => {} } },
  };
  let documentNumber = 0;
  const owner = wireSafariTiktokHost({ browser, randomId: () => crypto.randomUUID(), readCommitted: async () => ({ settings: DEFAULT_SETTINGS, options: { pro: true } }) });
  const sender = (documentId: string): TiktokRouteSender => ({ id: "still", url: tabs.get(7)!, frameId: 0, documentId, tab: { id: 7 } });
  const send = (kind: string, from: TiktokRouteSender): Promise<TiktokRouteReply | undefined> => new Promise((resolve) => {
    for (const fn of messages) if (fn({ kind }, from, resolve)) return;
    resolve(undefined);
  });
  /** What browser.runtime.connect does for the page: a port pair whose background end carries the actual sender. */
  const pageConnect = (from: TiktokRouteSender) => {
    const bgMessage = event<unknown>(), pageMessage = event<unknown>(), bgDisconnect = event<unknown>(), pageDisconnect = event<unknown>();
    let open = true;
    const drop = () => { if (!open) return; open = false; live.delete(drop); bgDisconnect.emit(null); pageDisconnect.emit(null); };
    live.add(drop);
    const bg: TiktokDocumentPort = { name: TIKTOK_DOCUMENT_PORT, sender: from, onMessage: bgMessage, onDisconnect: bgDisconnect, postMessage: (m) => { if (open) pageMessage.emit(m); }, disconnect: drop };
    const page: TiktokDocumentPort = { name: TIKTOK_DOCUMENT_PORT, onMessage: pageMessage, onDisconnect: pageDisconnect, postMessage: (m) => { if (open) bgMessage.emit(m); }, disconnect: drop };
    queueMicrotask(() => connect.emit(bg));
    return page;
  };
  return {
    owner, tabs, session, send, pageConnect,
    newDocument: () => sender(`native-${++documentNumber}`),
    /** Safari unloaded the idle background: every page port disconnects. */
    unload: () => { for (const drop of [...live]) drop(); },
    async block() {
      tabs.set(7, TIKTOK);
      return send(TIKTOK_ROUTE.blocked, { id: "still", url: TIKTOK, frameId: 0, documentId: "tiktok", tab: { id: 7 } });
    },
  };
}

describe("Safari blocked page document link", () => {
  it("resolves only after the background acknowledges this document's connection", async () => {
    const bg = background(); expect(await bg.block()).toEqual({ status: "redirected" });
    const me = bg.newDocument();
    const link = createTiktokDocumentLink({ connect: () => bg.pageConnect(me), timeoutMs: 500 });
    expect(await link.ensure()).toBe(true);
    expect(await bg.send(TIKTOK_ROUTE.request, me)).toEqual({ status: "confirming" });
    link.retire(); await bg.owner.stop();
  });

  it("reconnects after Safari unloads the background, so the next request still opens the confirmation", async () => {
    const bg = background(); await bg.block();
    const me = bg.newDocument();
    const connect = vi.fn(() => bg.pageConnect(me));
    const link = createTiktokDocumentLink({ connect, timeoutMs: 500 });
    expect(await link.ensure()).toBe(true);
    bg.unload(); await flush();
    expect(await bg.send(TIKTOK_ROUTE.request, me)).toEqual({ status: "failed" });
    expect(await link.ensure()).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(await bg.send(TIKTOK_ROUTE.request, me)).toEqual({ status: "confirming" });
    link.retire(); await bg.owner.stop();
  });

  it("a refused connection or no acknowledgement is not a link", async () => {
    const bg = background(); await bg.block();
    const foreign = { ...bg.newDocument(), id: "foreign" };
    const refused = createTiktokDocumentLink({ connect: () => bg.pageConnect(foreign), timeoutMs: 50 });
    expect(await refused.ensure()).toBe(false);
    const silent = createTiktokDocumentLink({
      connect: () => ({ name: TIKTOK_DOCUMENT_PORT, onMessage: event<unknown>(), onDisconnect: event<unknown>(), postMessage: () => {}, disconnect: () => {} }),
      timeoutMs: 20,
    });
    expect(await silent.ensure()).toBe(false);
    await bg.owner.stop();
  });

  it("a retired link never connects again", async () => {
    const bg = background(); await bg.block();
    const connect = vi.fn(() => bg.pageConnect(bg.newDocument()));
    const link = createTiktokDocumentLink({ connect, timeoutMs: 50 });
    link.retire();
    expect(await link.ensure()).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    await bg.owner.stop();
  });
});
