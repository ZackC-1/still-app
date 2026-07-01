import { parseHTML } from "linkedom";
import { createClient } from "@supabase/supabase-js";
import {
  runCanary,
  createNotifier,
  type CanaryPage,
  type CanaryStateStore,
  type HtmlMatcher,
  type PageFetcher,
} from "../_shared/canary.ts";

// Entrypoint (config.toml: verify_jwt=false; invoked by schedule — see docs/CONNECTIONS.md). Reads
// the current rule set, fetches each service's representative page, and alerts on selector rot or
// persistent unverifiability via the SELECTOR_CANARY_NOTIFY_URL webhook.

const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

// A representative page must never fill the isolate: bail up front on an oversized Content-Length,
// then stream with a hard byte cap (mirrors the client's rules/fetch.ts readCappedBody). Selector
// probing only needs the page's markup head — 4 MB is generous for any of the four services.
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

async function readCappedText(res: Response, controller: AbortController): Promise<string | null> {
  const declared = res.headers.get("content-length");
  if (declared && Number(declared) > MAX_PAGE_BYTES) return null;
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_PAGE_BYTES) {
      controller.abort();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const fetcher: PageFetcher = {
  async fetch(url): Promise<CanaryPage | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; StillCanary/1.0)" },
        signal: controller.signal,
      });
      const html = await readCappedText(res, controller);
      if (html === null) return null; // oversized → treated like an unreachable page
      return { status: res.status, html };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
};

// Parse each page once; reuse the document across a surface's selectors. (linkedom's parseHTML
// return type doesn't surface `.document` cleanly, so we narrow to the minimal shape we use.)
interface MinimalDocument {
  querySelectorAll(selector: string): ArrayLike<unknown>;
}
let cachedHtml = "";
let cachedDoc: MinimalDocument | null = null;
const matcher: HtmlMatcher = {
  count(html, selector) {
    if (html !== cachedHtml || !cachedDoc) {
      cachedHtml = html;
      cachedDoc = (parseHTML(html) as unknown as { document: MinimalDocument }).document;
    }
    try {
      return cachedDoc.querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  },
};

const state: CanaryStateStore = {
  async getNumber(key) {
    const { data } = await admin.from("canary_state").select("num").eq("key", key).maybeSingle<{ num: number }>();
    return data?.num ?? 0;
  },
  async setNumber(key, value) {
    await admin.from("canary_state").upsert({ key, num: value, updated_at: new Date().toISOString() });
  },
  async getFlag(key) {
    const { data } = await admin.from("canary_state").select("flag").eq("key", key).maybeSingle<{ flag: boolean }>();
    return data?.flag ?? false;
  },
  async setFlag(key, value) {
    await admin.from("canary_state").upsert({ key, flag: value, updated_at: new Date().toISOString() });
  },
};

const notifier = createNotifier(Deno.env.get("SELECTOR_CANARY_NOTIFY_URL") ?? undefined);

Deno.serve(async () => {
  const { data } = await admin.rpc("get_current_rule_set");
  const row = Array.isArray(data) ? data[0] : data;
  const ruleSet = (row?.payload as { services: Record<string, never> } | undefined) ?? { services: {} };
  const report = await runCanary(ruleSet, { fetcher, matcher, notifier, state });
  return new Response(JSON.stringify(report), { headers: { "content-type": "application/json" } });
});
