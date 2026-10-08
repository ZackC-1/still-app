import type { TiktokBrowserSender, TiktokTabBrowser } from "./browser-tiktok-tab-authority.js";

export const TIKTOK_DOCUMENT_PORT = "still:tiktok-document-v1";
const CHALLENGE = "still:tiktok-document-challenge";
const ANSWER = "still:tiktok-document-answer";
const TOKEN = /^[A-Za-z0-9-]{16,128}$/;
type Listener<T> = (value: T) => void;
interface Event<T> {
  addListener(listener: Listener<T>): void;
  removeListener(listener: Listener<T>): void;
}
export interface TiktokDocumentPort {
  readonly name: string;
  readonly sender?: TiktokBrowserSender;
  readonly onMessage: Event<unknown>;
  readonly onDisconnect: Event<unknown>;
  postMessage(message: unknown): void;
  disconnect(): void;
}
interface Connection {
  readonly port: TiktokDocumentPort;
  readonly sender: Readonly<TiktokBrowserSender>;
  readonly answers: Map<string, (answer: boolean) => void>;
  live: boolean;
  retire(): void;
}
const snapshot = (s: TiktokBrowserSender): Readonly<TiktokBrowserSender> => Object.freeze({
  id: s.id, url: s.url, frameId: s.frameId, documentId: s.documentId, tab: Object.freeze({ id: s.tab?.id }),
});
const same = (a: TiktokBrowserSender, b: TiktokBrowserSender) =>
  a.id === b.id && a.url === b.url && a.frameId === b.frameId &&
  a.documentId === b.documentId && a.tab?.id === b.tab?.id;

/** A live browser Port plus a fresh challenge, never cached metadata presented as getContexts. */
export function createTiktokDocumentRegistry(deps: {
  readonly runtimeId: string;
  readonly pageUrl: string;
  readonly tabs: NonNullable<TiktokTabBrowser["tabs"]>;
  readonly randomId: () => string;
  readonly timeoutMs?: number;
}) {
  const connections = new Map<number, Connection>();
  let stopped = false;
  const page = new URL(deps.pageUrl);
  const trusted = (s: TiktokBrowserSender): boolean => {
    if (s.id !== deps.runtimeId || s.frameId !== 0 || !Number.isSafeInteger(s.tab?.id) || s.tab!.id! < 0 ||
      typeof s.documentId !== "string" || !s.documentId.trim() || s.documentId.length > 128 || typeof s.url !== "string") return false;
    try {
      const u = new URL(s.url);
      return u.protocol === page.protocol && u.host === page.host && u.pathname === page.pathname && !u.username && !u.password;
    } catch { return false; }
  };
  function connect(port: TiktokDocumentPort): void {
    if (stopped || port.name !== TIKTOK_DOCUMENT_PORT || !port.sender || !trusted(port.sender)) {
      try { port.disconnect(); } catch { /* Already gone. */ }
      return;
    }
    const sender = snapshot(port.sender);
    const tabId = sender.tab!.id!;
    const previous = connections.get(tabId);
    previous?.retire();
    if (connections.size >= 128) { try { port.disconnect(); } catch { /* Already gone. */ } return; }
    const connection: Connection = {
      port, sender, live: true, answers: new Map(),
      retire() {
        if (!connection.live) return;
        connection.live = false;
        if (connections.get(tabId) === connection) connections.delete(tabId);
        for (const finish of [...connection.answers.values()]) finish(false);
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        try { port.disconnect(); } catch { /* Already gone. */ }
      },
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const m = message as { kind?: unknown; challenge?: unknown };
      if (Object.keys(m).length !== 2 || m.kind !== ANSWER || typeof m.challenge !== "string") return;
      connection.answers.get(m.challenge)?.(true);
    };
    const onDisconnect = () => connection.retire();
    connections.set(tabId, connection);
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
  }
  const live = (c: Connection) => !stopped && c.live && connections.get(c.sender.tab!.id!) === c;
  async function currentTab(c: Connection): Promise<boolean> {
    if (!live(c)) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const tab = await Promise.race([
        deps.tabs.get(c.sender.tab!.id!),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Tab proof expired")), deps.timeoutMs ?? 1_000); }),
      ]);
      return live(c) && tab.id === c.sender.tab!.id && (!tab.pendingUrl || tab.pendingUrl === c.sender.url) &&
        (!tab.url || tab.url === c.sender.url);
    } catch { return false; } finally { clearTimeout(timer); }
  }
  function challenge(c: Connection): Promise<boolean> {
    if (!live(c) || c.answers.size >= 4) return Promise.resolve(false);
    let token: string;
    try { token = deps.randomId(); } catch { return Promise.resolve(false); }
    if (!TOKEN.test(token) || c.answers.has(token)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), deps.timeoutMs ?? 1_000);
      const finish = (answer: boolean) => {
        if (!c.answers.delete(token)) return;
        clearTimeout(timer);
        resolve(answer && live(c));
      };
      c.answers.set(token, finish);
      try { c.port.postMessage({ kind: CHALLENGE, challenge: token }); } catch { finish(false); }
    });
  }
  const removed = (id: number) => connections.get(id)?.retire();
  const replaced = (_added: number, removedId: number) => removed(removedId);
  deps.tabs.onRemoved.addListener(removed);
  deps.tabs.onReplaced.addListener(replaced);
  return {
    connect,
    capture(sender: Readonly<TiktokBrowserSender>): () => Promise<boolean> {
      const c = connections.get(sender.tab?.id ?? -1);
      if (!c || !trusted(sender) || !same(sender, c.sender)) return async () => false;
      return async () => (await currentTab(c)) && (await challenge(c)) && (await currentTab(c)) && live(c);
    },
    stop() {
      stopped = true;
      for (const c of [...connections.values()]) c.retire();
      deps.tabs.onRemoved.removeListener(removed);
      deps.tabs.onReplaced.removeListener(replaced);
    },
  };
}

/** The packaged page answers only this connection's bounded challenge; pagehide disconnects. */
export function answerTiktokDocumentChallenges(port: TiktokDocumentPort): () => void {
  let live = true;
  const answer = (message: unknown) => {
    if (!live || !message || typeof message !== "object" || Array.isArray(message)) return;
    const m = message as { kind?: unknown; challenge?: unknown };
    if (Object.keys(m).length !== 2 || m.kind !== CHALLENGE || typeof m.challenge !== "string" || !TOKEN.test(m.challenge)) return;
    try { port.postMessage({ kind: ANSWER, challenge: m.challenge }); } catch { stop(); }
  };
  const stop = () => {
    if (!live) return;
    live = false;
    port.onMessage.removeListener(answer);
    port.onDisconnect.removeListener(stop);
    try { port.disconnect(); } catch { /* Already gone. */ }
  };
  port.onMessage.addListener(answer);
  port.onDisconnect.addListener(stop);
  return stop;
}
