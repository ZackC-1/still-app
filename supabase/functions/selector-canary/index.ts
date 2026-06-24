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

const fetcher: PageFetcher = {
  async fetch(url): Promise<CanaryPage | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; StillCanary/1.0)" },
        signal: controller.signal,
      });
      return { status: res.status, html: await res.text() };
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
