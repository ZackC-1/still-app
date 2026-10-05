import { EXTENSION_ID, EXTENSION_UUID } from "./_bidi.js";
import {
  FIREFOX_EXTENSION,
  StillFirefox,
  Tab,
  fixture,
  type Router,
} from "./_session.js";
import { FirefoxChrome } from "./_qa-capture.js";
import { redact } from "../qa/shared/evidence.js";

// Helpers for the Firefox QA specs, on top of the existing BiDi session (_session.ts). Real storage
// and real extension pages only: state is read and written through the extension's own page with
// `browser.storage.local`, the same call the product makes. No product hook exists or is added.
//
// Limits that shape these helpers (QA-P0 item 2): BiDi refuses input and screenshots on extension
// pages, so a "click" is the page's own element.click() (a script click, not a trusted one), and
// pictures come from _qa-capture.ts. BiDi interception does not see the background's own requests.

export const FIRST_RUN_URL = `moz-extension://${EXTENSION_UUID}/first-run.html`;

/** The same recorded pages the Chromium lane serves, by host. Never a real site. */
export const qaRouter: Router = (url) => {
  if (url.pathname.startsWith("/watch"))
    return "<!doctype html><title>watch</title>watch";
  const host = url.hostname;
  if (host.endsWith("youtube.com")) return fixture("youtube.html");
  if (host.endsWith("instagram.com")) return fixture("instagram.html");
  if (host.endsWith("facebook.com")) return fixture("facebook.html");
  if (host.endsWith("tiktok.com")) return fixture("tiktok.html");
  return null;
};

/** A fresh Firefox profile with the built extension installed and its first-run page open. */
export async function startFresh(
  router: Router = qaRouter,
): Promise<StillFirefox> {
  const firefox = await StillFirefox.start();
  firefox.serve(router);
  await firefox.waitForModernSettings();
  return firefox;
}

async function contexts(
  firefox: StillFirefox,
): Promise<{ context: string; url: string }[]> {
  const tree = await firefox.bidi.send("browsingContext.getTree", {});
  return (tree.contexts as { context: string; url: string }[]).map((c) => ({
    context: c.context,
    url: c.url,
  }));
}

/** Every open tab whose address starts with `prefix`. */
export async function tabsWith(
  firefox: StillFirefox,
  prefix: string,
): Promise<Tab[]> {
  return (await contexts(firefox))
    .filter((c) => c.url.startsWith(prefix))
    .map((c) => new Tab(firefox.bidi, c.context));
}

/** The first-run page the install opened (waits for it). */
export async function firstRunTab(
  firefox: StillFirefox,
  timeoutMs = 15_000,
): Promise<Tab> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [tab] = await tabsWith(firefox, FIRST_RUN_URL);
    if (tab) return tab;
    if (Date.now() > deadline)
      throw new Error("the first-run page never opened");
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Run `fn` in a short-lived extension page, which is where `browser.*` exists. */
export async function inExtension<T>(
  firefox: StillFirefox,
  fn: (page: Tab) => Promise<T>,
): Promise<T> {
  const page = await firefox.openExtensionPage("options.html");
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

export const readStore = <T = unknown>(
  firefox: StillFirefox,
  key: string,
): Promise<T | null> =>
  inExtension(firefox, (page) =>
    page.evaluate<T | null>(
      `browser.storage.local.get(${JSON.stringify(key)}).then((r) => r[${JSON.stringify(key)}] ?? null)`,
    ),
  );

export const writeStore = (
  firefox: StillFirefox,
  items: Record<string, unknown>,
): Promise<void> =>
  inExtension(firefox, async (page) => {
    await page.evaluate(
      `browser.storage.local.set(${JSON.stringify(items)}).then(() => true)`,
    );
  });

export type Saved = {
  settings: {
    schemaVersion: number;
    globalOn: boolean;
    services: Record<string, boolean>;
    pauses: string[];
  };
  atomic?: { ownership?: string };
};
export const savedSettings = async (firefox: StillFirefox): Promise<Saved> =>
  (await readStore<Saved>(firefox, "still:settings")) as Saved;

/** Every still:* key, sensitive values redacted. */
export async function storeDump(
  firefox: StillFirefox,
): Promise<Record<string, unknown>> {
  const all = await inExtension(firefox, (page) =>
    page.evaluate<Record<string, unknown>>(`browser.storage.local.get(null)`),
  );
  return Object.fromEntries(
    Object.entries(all)
      .filter(([key]) => key.startsWith("still:") || key.startsWith("still."))
      .map(([key, value]) => [key, redact(value, key)]),
  );
}

export type NetworkEntry = { method: string; origin: string; path: string };

/**
 * Page requests the browser makes, as method, origin and path only (no query, headers or body).
 * The background script's own requests are invisible to BiDi, so this proves what pages did, and
 * the lane's unconfigured-build check proves the background has nowhere to send anything.
 */
export function recordRequests(firefox: StillFirefox): {
  entries: NetworkEntry[];
  external(): NetworkEntry[];
} {
  const entries: NetworkEntry[] = [];
  firefox.bidi.on("network.beforeRequestSent", (event) => {
    const url = new URL(String(event.request?.url));
    if (["moz-extension:", "about:", "data:", "blob:"].includes(url.protocol))
      return;
    entries.push({
      method: String(event.request?.method),
      origin: url.origin,
      path: url.pathname,
    });
  });
  return {
    entries,
    external: () =>
      entries.filter(
        (e) =>
          !/(^|\.)(youtube|instagram|facebook|tiktok)\.com$/.test(
            new URL(e.origin).hostname,
          ),
      ),
  };
}

/** Remove the add-on (its storage goes with it) and install the same build again. */
export async function reinstall(firefox: StillFirefox): Promise<void> {
  await firefox.bidi.send("webExtension.uninstall", {
    extension: EXTENSION_ID,
  });
  await new Promise((done) => setTimeout(done, 1000));
  // Firefox forgets an add-on's pinned address when it is removed and would pick a random one on
  // install. Writing the same mapping back first lets the tests keep opening pages by URL.
  await (
    await FirefoxChrome.attach(firefox.bidi)
  ).eval(
    `Services.prefs.setStringPref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [EXTENSION_ID]: EXTENSION_UUID }))}), true`,
  );
  await firefox.bidi.send("webExtension.install", {
    extensionData: { type: "path", path: FIREFOX_EXTENSION },
  });
}

export const NEEDS_BACKEND =
  "Needs the QA-P7 local backend recipe (sign-in, sync); enable when that lands";
export const FIREFOX_ONLY_BUILD =
  "The Firefox lane runs the unconfigured V3 build (StillFirefox.start refuses a build with a server compiled in)";
