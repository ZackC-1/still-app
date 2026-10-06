import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serviceWorker } from "./launch.mjs";

// Evidence a journey leaves behind: screenshots (2x), a storage dump and a network log. All of it
// goes under tests/qa/.output (gitignored), never into a public path. Storage values that could
// identify a person or hold a credential are redacted before they are written.

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVIDENCE_ROOT = resolve(process.env.STILL_QA_EVIDENCE ?? join(HERE, "../.output/evidence"));

const SENSITIVE =
  /token|secret|key|session|email|code|password|jwt|auth|identity|user|id$|Id$|_id$|account|install|anchor|lineage|distinct|otp/i;
// A UUID, or a JWT (three dot-separated base64url parts, the first two starting "ey"), under any key.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT = /^ey[A-Za-z0-9_-]+\.ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** Copy a storage value, replacing anything that could hold a credential or an identifier. */
export function redact(value: unknown, key = ""): unknown {
  if (typeof value === "string" && (UUID.test(value) || JWT.test(value))) return "[redacted]";
  if (SENSITIVE.test(key) && value !== null && typeof value !== "boolean" && typeof value !== "number")
    return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}

export class Evidence {
  private count = 0;
  readonly dir: string;

  constructor(
    readonly cell: string,
    testInfo: TestInfo,
  ) {
    const slug = testInfo.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    this.dir = join(EVIDENCE_ROOT, cell, slug);
    mkdirSync(this.dir, { recursive: true });
  }

  private next(step: string): string {
    this.count += 1;
    return join(this.dir, `${String(this.count).padStart(2, "0")}-${step.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`);
  }

  async shot(page: Page, step: string): Promise<void> {
    await page.screenshot({ path: `${this.next(step)}.png`, animations: "disabled" });
  }

  /** Every still:* key in extension storage, with sensitive values redacted. */
  async storage(context: BrowserContext, step: string): Promise<Record<string, unknown>> {
    const worker = await serviceWorker(context);
    const all = (await worker.evaluate(() => chrome.storage.local.get(null))) as Record<string, unknown>;
    const dump = Object.fromEntries(
      Object.entries(all)
        .filter(([key]) => key.startsWith("still:") || key.startsWith("still."))
        .map(([key, value]) => [key, redact(value, key)]),
    );
    writeFileSync(`${this.next(step)}.storage.json`, `${JSON.stringify(dump, null, 2)}\n`);
    return dump;
  }

  log(step: string, entries: unknown): void {
    writeFileSync(`${this.next(step)}.json`, `${JSON.stringify(entries, null, 2)}\n`);
  }
}

export type NetworkEntry = { method: string; origin: string; path: string };

/**
 * Record every request the browser makes (pages and the extension's own background), as method,
 * origin and path only: no query strings, headers or bodies, so the log carries no identifier.
 */
export function recordNetwork(context: BrowserContext): { entries: NetworkEntry[]; external(): NetworkEntry[] } {
  const entries: NetworkEntry[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "chrome-extension:" || url.protocol === "data:" || url.protocol === "blob:") return;
    entries.push({ method: request.method(), origin: url.origin, path: url.pathname });
  });
  return {
    entries,
    external: () => entries.filter((entry) => !entry.origin.startsWith("http://127.0.0.1")),
  };
}
