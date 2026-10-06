import { expect } from "./_extension.js";
import type { BrowserContext, Page, Worker } from "@playwright/test";
import { EXTRAS_CONTROLS, EXTRAS_INTENT_PATHS } from "../../packages/core/src/rules/__tests__/extras-fixtures.js";

// Shared by the extras specs: synthetic schema-2 settings, fixture serving and a residue scan.

export async function commitIntent(context: BrowserContext, extensionId: string, path: string, value: boolean) {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const reply = await options.evaluate(
    ({ path, value }) =>
      (globalThis as unknown as { chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } } }).chrome.runtime
        .sendMessage({ kind: "still:settings-intent", path, value, updatedAt: Date.now() }),
    { path, value },
  );
  expect(reply, path).toMatchObject({ status: "committed" });
  await options.close();
}

/** The settings the shipped authority actually holds, so the dormancy claim cannot be vacuous. */
export async function storedSites(context: BrowserContext): Promise<Record<string, boolean>> {
  const [worker] = context.serviceWorkers() as [Worker];
  return worker.evaluate(async () => {
    const raw = await (globalThis as unknown as {
      chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
    }).chrome.storage.local.get("still:settings");
    const record = raw["still:settings"] as { settings: { sites: Record<string, boolean> } };
    return record.settings.sites;
  });
}

export async function setAllExtras(context: BrowserContext, extensionId: string, value: boolean) {
  for (const path of EXTRAS_INTENT_PATHS) await commitIntent(context, extensionId, path, value);
  const sites = await storedSites(context);
  for (const control of EXTRAS_CONTROLS) expect(sites[control.feature], control.feature).toBe(value);
}

export async function serve(page: Page, glob: string, html: string) {
  await page.route(glob, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
}

/** Free feature classes the owned stylesheet may be scoped to. Anything else is an extras leak. */
export const FREE_SCOPE = /^\.still-feature-\d+-(youtube-shorts|instagram-reels|facebook-reels|tiktok-all)(\s|$)/;
export const EXTRAS_FEATURE_CLASS =
  /still-feature-\d+-(youtube-(related|endscreen|autoplay|comments|livechat)|instagram-(explore|stories|suggested|threads)|facebook-(stories|videos|sponsored))/;

/** Everything Still could have added to the page: owned classes (on any element), markers, style rules. */
export async function stillResidue(page: Page) {
  return page.evaluate(() => {
    const classes: string[] = [];
    const attributes: string[] = [];
    for (const el of document.querySelectorAll("*")) {
      const where = `${el.tagName.toLowerCase()}#${el.id}`;
      for (const name of el.classList) if (name.startsWith("still-")) classes.push(`${where}.${name}`);
      for (const attr of el.getAttributeNames())
        if (attr.startsWith("data-still")) attributes.push(`${where}[${attr}]`);
    }
    classes.sort();
    const sheets = [
      ...[...document.querySelectorAll("style")].map((s) => s.textContent ?? ""),
      ...[...document.adoptedStyleSheets].map((s) => [...s.cssRules].map((r) => r.cssText).join("\n")),
    ];
    const rules = sheets.flatMap((text) => text.split("\n")).map((line) => line.trim()).filter(Boolean);
    return { classes, attributes, sheets, rules, ownedElements: document.querySelectorAll("[id^='still-']").length };
  });
}

/** The owned stylesheet's rules: each must be scoped to a free feature class, none to an extra. */
export function expectOnlyFreeScopedRules(rules: readonly string[]) {
  expect(rules.length, "the engine's owned stylesheet is present, so this check is not vacuous").toBeGreaterThan(0);
  for (const rule of rules) {
    expect(rule, "no extras feature class in style text").not.toMatch(EXTRAS_FEATURE_CLASS);
    expect(rule, "every owned rule is scoped to a free feature class").toMatch(FREE_SCOPE);
  }
}

/** Copy the product has approved that legitimately contains a purchase word (strip before scanning). */
export const APPROVED_PURCHASE_COPY = [
  "If you were charged, Restore purchase will find it.",
  "Already purchased? Restore",
  "Restore purchase",
] as const;

const PURCHASE_WORDS =
  /\b(buy|purchase|purchased|upgrade|subscribe|checkout|price|pricing)\b|[$€£]\s?\d|\d\s?(usd|eur|gbp)\b/i;

/** True when text offers a purchase, ignoring only the exact approved strings above. */
export function offersPurchase(text: string): boolean {
  let rest = text.replace(/\s+/g, " ");
  for (const approved of APPROVED_PURCHASE_COPY) rest = rest.split(approved).join(" ");
  return PURCHASE_WORDS.test(rest);
}
