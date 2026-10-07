import { afterEach, describe, expect, it, vi } from "vitest";
import { createTiktokDocumentRegistry, answerTiktokDocumentChallenges, TIKTOK_DOCUMENT_PORT, type TiktokDocumentPort } from "../tiktok-document-port.js";
import type { TiktokBrowserSender } from "../browser-tiktok-tab-authority.js";

afterEach(() => vi.useRealTimers());
function event<T>() {
  const listeners = new Set<(value: T) => void>();
  return { addListener: (fn: (value: T) => void) => { listeners.add(fn); }, removeListener: (fn: (value: T) => void) => { listeners.delete(fn); }, emit: (value: T) => { for (const fn of [...listeners]) fn(value); } };
}
const PAGE = "safari-web-extension://still/tiktok-blocked.html?r=request-1";
const sender = (documentId = "native-document-1", tab = 7): TiktokBrowserSender => ({ id: "still", url: PAGE, frameId: 0, documentId, tab: { id: tab } });
function pair(s: TiktokBrowserSender = sender()) {
  const backgroundMessage = event<unknown>(), pageMessage = event<unknown>();
  const backgroundDisconnect = event<unknown>(), pageDisconnect = event<unknown>();
  let alive = true;
  const disconnect = () => { if (!alive) return; alive = false; backgroundDisconnect.emit(null); pageDisconnect.emit(null); };
  const background: TiktokDocumentPort = { name: TIKTOK_DOCUMENT_PORT, sender: s, onMessage: backgroundMessage, onDisconnect: backgroundDisconnect, postMessage: (message) => pageMessage.emit(message), disconnect };
  const page: TiktokDocumentPort = { name: TIKTOK_DOCUMENT_PORT, onMessage: pageMessage, onDisconnect: pageDisconnect, postMessage: (message) => backgroundMessage.emit(message), disconnect };
  return { background, page, backgroundMessage, pageMessage, disconnect };
}
function harness(timeoutMs = 20) {
  const removed = event<number>();
  const replaced = new Set<(added: number, removed: number) => void>();
  const get = vi.fn(async (id: number) => ({ id } as { id: number; url?: string; pendingUrl?: string }));
  const tabs = { get, onRemoved: removed, onReplaced: { addListener: (fn: (a: number, r: number) => void) => { replaced.add(fn); }, removeListener: (fn: (a: number, r: number) => void) => { replaced.delete(fn); } } };
  const registry = createTiktokDocumentRegistry({ runtimeId: "still", pageUrl: PAGE, tabs, randomId: () => crypto.randomUUID(), timeoutMs });
  return { registry, get, removed, replace: () => { for (const fn of replaced) fn(8, 7); } };
}

describe("Safari current native document Port proof", () => {
  it("requires a fresh answer on the same live browser connection for every verification", async () => {
    const h = harness(); const p = pair(); h.registry.connect(p.background);
    const messages: unknown[] = []; p.pageMessage.addListener((m) => { messages.push(m); });
    const retire = answerTiktokDocumentChallenges(p.page);
    const verify = h.registry.capture(sender());
    expect(await verify()).toBe(true); expect(await verify()).toBe(true);
    expect(messages).toHaveLength(2); expect(messages[0]).not.toEqual(messages[1]);
    expect(messages[0]).toEqual({ kind: "still:tiktok-document-challenge", challenge: expect.any(String) });
    // 'document' occurs only in the fixed message kind, never as an identity field.
    retire(); expect(await verify()).toBe(false); h.registry.stop();
  });
  it.each([
    { id: "foreign" }, { frameId: 1 }, { documentId: undefined }, { tab: { id: -1 } },
    { url: "https://www.tiktok.com/" }, { url: "safari-web-extension://foreign/tiktok-blocked.html" },
    { url: "safari-web-extension://still/options.html" },
  ])("rejects native sender mismatch %j, regardless of payload assertions", async (override) => {
    const h = harness(); const p = pair({ ...sender(), ...override });
    answerTiktokDocumentChallenges(p.page); h.registry.connect(p.background);
    p.backgroundMessage.emit({ kind: "still:tiktok-document-answer", challenge: crypto.randomUUID(), documentId: "native-document-1" });
    expect(await h.registry.capture(sender())()).toBe(false); h.registry.stop();
  });
  it("rejects silent, malformed and stale answers", async () => {
    vi.useFakeTimers();
    const h = harness(); const p = pair(); h.registry.connect(p.background);
    const tokens: string[] = [];
    p.pageMessage.addListener((m) => tokens.push((m as { challenge: string }).challenge));
    const first = h.registry.capture(sender())(); await vi.advanceTimersByTimeAsync(20); expect(await first).toBe(false);
    const next = h.registry.capture(sender())(); await vi.advanceTimersByTimeAsync(0);
    p.backgroundMessage.emit({ kind: "still:tiktok-document-answer", challenge: tokens[0] });
    p.backgroundMessage.emit({ kind: "still:tiktok-document-answer", challenge: tokens[1], granted: true });
    await vi.advanceTimersByTimeAsync(20); expect(await next).toBe(false); h.registry.stop();
  });
  it("an answer on another connection cannot settle this connection's challenge", async () => {
    vi.useFakeTimers(); const h = harness(); const first = pair(), other = pair(sender("native-document-2", 8));
    h.registry.connect(first.background); h.registry.connect(other.background);
    first.pageMessage.addListener((m) => other.backgroundMessage.emit({ kind: "still:tiktok-document-answer", challenge: (m as { challenge: string }).challenge }));
    const result = h.registry.capture(sender())(); await vi.advanceTimersByTimeAsync(20); expect(await result).toBe(false); h.registry.stop();
  });
  it("same-URL new documents retire all prior captured proof, even after a valid answer", async () => {
    const h = harness(); const first = pair(); h.registry.connect(first.background); answerTiktokDocumentChallenges(first.page);
    const old = h.registry.capture(sender()); expect(await old()).toBe(true);
    const replacement = pair(sender("native-document-2")); h.registry.connect(replacement.background); answerTiktokDocumentChallenges(replacement.page);
    expect(await old()).toBe(false); expect(await h.registry.capture(sender("native-document-2"))()).toBe(true); h.registry.stop();
  });
  it("a different native request document cannot borrow the live connection's proof", async () => {
    const h = harness(); const p = pair(); h.registry.connect(p.background); answerTiktokDocumentChallenges(p.page);
    expect(await h.registry.capture(sender("native-document-2"))()).toBe(false);
    expect(await h.registry.capture(sender())()).toBe(true); h.registry.stop();
  });
  it("pagehide disposal rejects an already pending challenge", async () => {
    const h = harness(); const p = pair(); h.registry.connect(p.background);
    const retire = answerTiktokDocumentChallenges(p.page);
    // Disposing the page immediately before delivery cannot acknowledge the challenge.
    const post = p.background.postMessage;
    p.background.postMessage = (m) => { retire(); post(m); };
    expect(await h.registry.capture(sender())()).toBe(false); h.registry.stop();
  });
  it.each(["disconnect", "replace", "close", "stop"] as const)("%s fences a pending native tab read", async (kind) => {
    const h = harness(); const p = pair(); h.registry.connect(p.background); answerTiktokDocumentChallenges(p.page);
    let resolve!: (v: { id: number }) => void; h.get.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const result = h.registry.capture(sender())();
    if (kind === "disconnect") p.disconnect(); else if (kind === "replace") h.replace(); else if (kind === "close") h.removed.emit(7); else h.registry.stop();
    resolve({ id: 7 }); expect(await result).toBe(false); h.registry.stop();
  });
  it("a delayed final tab read cannot revalidate a replaced connection", async () => {
    const h = harness(); const p = pair(); h.registry.connect(p.background); answerTiktokDocumentChallenges(p.page);
    let resolve!: (v: { id: number }) => void;
    h.get.mockResolvedValueOnce({ id: 7 }).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const result = h.registry.capture(sender())(); for (let i=0;i<10;i++) await Promise.resolve();
    const replacement = pair(); h.registry.connect(replacement.background); answerTiktokDocumentChallenges(replacement.page);
    resolve({ id: 7 }); expect(await result).toBe(false); h.registry.stop();
  });
  it("pending navigation and different visible tab URL hold proof; stalled tab reads are bounded", async () => {
    const h = harness(); const p = pair(); h.registry.connect(p.background); answerTiktokDocumentChallenges(p.page);
    h.get.mockResolvedValueOnce({ id: 7, pendingUrl: "https://example.com/" }); expect(await h.registry.capture(sender())()).toBe(false);
    h.get.mockResolvedValueOnce({ id: 7, url: "https://example.com/" }); expect(await h.registry.capture(sender())()).toBe(false);
    vi.useFakeTimers(); h.get.mockImplementationOnce(() => new Promise(() => {}));
    const result = h.registry.capture(sender())(); await vi.advanceTimersByTimeAsync(20); expect(await result).toBe(false); h.registry.stop();
  });
  it("background restart has no document proof until a fresh connection binds", async () => {
    const h = harness(); const p = pair(); h.registry.connect(p.background); answerTiktokDocumentChallenges(p.page);
    const old = h.registry.capture(sender()); h.registry.stop();
    const reopened = harness(); expect(await old()).toBe(false); expect(await reopened.registry.capture(sender())()).toBe(false);
    const next = pair(); reopened.registry.connect(next.background); answerTiktokDocumentChallenges(next.page);
    expect(await reopened.registry.capture(sender())()).toBe(true); reopened.registry.stop();
  });
});
