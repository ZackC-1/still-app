import {
  answerTiktokDocumentChallenges,
  TIKTOK_DOCUMENT_READY,
  type TiktokDocumentPort,
} from "@still/core/content/tiktok-document-port";

/**
 * The Safari blocked page's live link to the background (the document port the background uses to
 * re-prove this exact page). Safari unloads an idle background about two minutes after the last
 * port activity and drops the port with it; the page then reconnects on its next request instead
 * of going inert. A link counts only once the background has acknowledged the connection.
 */
export function createTiktokDocumentLink(deps: {
  readonly connect: () => TiktokDocumentPort;
  /** Bound on the background's acknowledgement. */
  readonly timeoutMs?: number;
}) {
  let retired = false;
  let current: { port: TiktokDocumentPort; ready: Promise<boolean>; stop: () => void } | null = null;

  function open(): Promise<boolean> {
    let port: TiktokDocumentPort;
    try {
      port = deps.connect();
    } catch {
      return Promise.resolve(false);
    }
    const stopAnswering = answerTiktokDocumentChallenges(port);
    let settle!: (linked: boolean) => void;
    const ready = new Promise<boolean>((resolve) => { settle = resolve; });
    const timer = setTimeout(() => drop(), deps.timeoutMs ?? 3_000);
    const onMessage = (message: unknown) => {
      if (message && typeof message === "object" && (message as { kind?: unknown }).kind === TIKTOK_DOCUMENT_READY) {
        clearTimeout(timer);
        settle(true);
      }
    };
    const link = { port, ready, stop: () => drop() };
    function drop() {
      clearTimeout(timer);
      settle(false);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(drop);
      stopAnswering();
      if (current === link) current = null;
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(drop);
    current = link;
    return ready;
  }

  return {
    /** True when this document is connected and acknowledged, reconnecting once if it is not. */
    async ensure(): Promise<boolean> {
      if (retired) return false;
      const existing = current;
      if (existing && (await existing.ready) && current === existing) return true;
      if (retired) return false;
      return current && current !== existing ? current.ready : open();
    },
    /** The document is leaving: disconnect and never reconnect. */
    retire(): void {
      retired = true;
      current?.stop();
    },
  };
}
