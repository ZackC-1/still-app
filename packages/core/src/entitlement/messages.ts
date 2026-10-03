import type { ChromeEntitlementAdapter } from "./chrome-adapter.js";

/** Legacy compatibility writes and modern observations use the same background writer. Modern
 * installation/revocation is internal verified authority only, never a caller-chosen message. */
export function createEntitlementMessageRouter(adapter: ChromeEntitlementAdapter, extensionId: string, extensionOrigin: string) {
  return (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void): boolean => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const m = message as Record<string, unknown>;
    if (m.kind === "observeBenefits") {
      if (Object.keys(m).length !== 1 || sender.id !== extensionId || typeof sender.url !== "string" || !isAccessReader(sender.url, extensionOrigin)) return false;
      void adapter.observeBenefits().then(snapshot => reply({ ok: true, snapshot }), () => reply({ ok: false }));
      return true;
    }
    if (m.kind !== "setEntitlementRecord" && m.kind !== "observeAccess") return false;
    if (sender.id !== extensionId || typeof sender.url !== "string" || !sender.url.startsWith(extensionOrigin)) return false;
    if (m.kind === "observeAccess" && Object.keys(m).length === 1) {
      void adapter.observeAccess().then(record => reply({ ok: true, record }), () => reply({ ok: false }));
      return true;
    }
    if (m.kind === "setEntitlementRecord" && Object.keys(m).length === 2 && m.record && typeof m.record === "object" && !Array.isArray(m.record)) {
      const r = m.record as Record<string, unknown>;
      if (Object.keys(r).some(k => !["entitled", "updatedAt", "userId"].includes(k)) || typeof r.entitled !== "boolean" ||
          typeof r.updatedAt !== "number" || !Number.isFinite(r.updatedAt) || (r.userId !== undefined && typeof r.userId !== "string")) return false;
      void adapter.setRecord({ entitled: r.entitled, updatedAt: r.updatedAt, ...(r.userId === undefined ? {} : { userId: r.userId }) })
        .then(() => reply({ ok: true }), () => reply({ ok: false }));
      return true;
    }
    return false;
  };
}

// Only this read-only projection lane admits own content scripts. Legacy mutations/record
// observation retain their extension-page-only route and no caller authority fields are read.
function isAccessReader(text: string, extensionOrigin: string): boolean {
  try {
    const url = new URL(text), own = new URL(extensionOrigin);
    if (url.protocol === own.protocol && url.host === own.host && url.username === "" && url.password === "") return true;
    return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "" && [
      "youtube.com", "www.youtube.com", "m.youtube.com", "instagram.com", "www.instagram.com",
      "facebook.com", "www.facebook.com", "m.facebook.com", "tiktok.com", "www.tiktok.com", "m.tiktok.com",
    ].includes(url.hostname);
  } catch { return false; }
}
