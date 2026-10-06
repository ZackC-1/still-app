// Read one-time sign-in codes from the QA stack's local Mailpit (the CLI's "inbucket" service, port
// 54324 by default). Codes come from the QA-only template (templates/qa-code.html), which prints
// "QA-CODE: <digits>". Local addresses only.
import { assertLocalUrl } from "./guard.mjs";

const CODE = /QA-CODE:\s*(\d{6,10})\b/;

/** Pull the code out of a message body. Null when the QA marker is absent. */
export function extractCode(text) {
  const match = CODE.exec(String(text ?? ""));
  return match ? match[1] : null;
}

/**
 * Wait for the newest message to `email` received at or after `since` (ms) and return its code.
 * Throws after `timeoutMs`.
 */
export async function waitForCode({ mailpitUrl, email, since = 0, timeoutMs = 15_000, intervalMs = 250, fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const base = assertLocalUrl(mailpitUrl, "Mailpit URL").replace(/\/+$/, "");
  if (!/^[^\s"@]+@[^\s"@]+$/.test(String(email))) throw new Error("waitForCode needs one plain email address");
  const deadline = now() + timeoutMs;
  for (;;) {
    const search = await fetchImpl(`${base}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=5`);
    if (!search.ok) throw new Error(`Mailpit search failed (${search.status})`);
    const { messages = [] } = await search.json();
    const fresh = messages
      .filter(message => Date.parse(message.Created) >= since)
      .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created));
    for (const message of fresh) {
      const body = await fetchImpl(`${base}/api/v1/message/${encodeURIComponent(message.ID)}`);
      if (!body.ok) continue;
      const { Text, HTML } = await body.json();
      const code = extractCode(Text) ?? extractCode(HTML);
      if (code) return code;
    }
    if (now() >= deadline) throw new Error(`no QA sign-in code for ${email} within ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

/** Delete every message (start each run with an empty inbox). */
export async function clearInbox({ mailpitUrl, fetchImpl = fetch }) {
  const base = assertLocalUrl(mailpitUrl, "Mailpit URL").replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/api/v1/messages`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Mailpit clear failed (${response.status})`);
}
