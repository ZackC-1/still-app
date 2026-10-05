// QA-ONLY. The WebKit bundle lane (T2): the BUILT Safari extension pages and the BUILT Apple web
// view, opened in Playwright WebKit at 2x, with the native host boundary answered by the
// recorded-state shim (shim/). Used by the lane's specs and by the T2 visual runner
// (tests/visual/real/webkit/run.mjs). Product code is served exactly as built; nothing is patched.
//
// What this is not: Safari, iOS or the Safari extension runtime. Safari's popup sheet, popover and
// window chrome are not rendered here, and no content script runs. It proves the page code, its
// layout in WebKit and its behaviour against recorded native replies (QA plan §2.3, tier T2).
import { webkit, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BOUNDARY_SHIM_MARKER, installBoundaryShim } from "./shim/boundary-shim.js";
import { NativeModel } from "./shim/native-model.js";
import { STATES, type QaState, type StateName } from "./shim/states.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

/** The built Safari Web Extension resources (the V3 opt-in build; see README). */
export const SAFARI_EXTENSION = resolve(process.env.STILL_SAFARI_EXTENSION ?? join(REPO, "packages/ext-safari/dist/safari-mv3"));
/** The built single-file Apple web view (the D04/D12 opt-in build; see README). */
export const APPLE_WEBVIEW = resolve(process.env.STILL_APPLE_WEBVIEW ?? join(REPO, "packages/app-webview/dist"));

/** The uppercase host Safari gives an installed extension's pages. Any fixed UUID will do. */
const EXTENSION_HOST = "5A6F7E1C-0B3D-4C2A-9E8F-7D6C5B4A3F21";
/** A fixed wall clock for every page (the recorded edits are stamped 2026-10-01). */
export const QA_CLOCK = new Date("2026-10-05T12:00:00Z");

export const BUILD_COMMANDS = [
  "VITE_APPLE_ATOMIC_SETTINGS=true pnpm --filter @still/ext-safari build",
  "VITE_APPLE_ATOMIC_SETTINGS=true pnpm --filter @still/app-webview build",
];

/**
 * The lane needs the opted-in (V3) builds: default builds fold the V3 screens away. Returns what is
 * missing, empty when both builds are usable. Unconfigured only: a Supabase-configured build never
 * contains the V3 screens.
 */
export function buildProblems(): string[] {
  const problems: string[] = [];
  const chunks = join(SAFARI_EXTENSION, "chunks");
  if (!existsSync(join(SAFARI_EXTENSION, "popup.html")) || !existsSync(chunks))
    problems.push(`no built Safari extension at ${SAFARI_EXTENSION}`);
  else if (!readdirSync(chunks).some((f) => f.startsWith("v3-mount")))
    problems.push(`${SAFARI_EXTENSION} is a default build without the V3 screens`);
  const app = join(APPLE_WEBVIEW, "index.html");
  if (!existsSync(app)) problems.push(`no built Apple web view at ${APPLE_WEBVIEW}`);
  else if (!readFileSync(app, "utf8").includes("still-onboarding-presenter:web-d12"))
    problems.push(`${APPLE_WEBVIEW} is a default build without the D04/D12 screens`);
  return problems;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export interface StaticOrigin {
  readonly origin: string;
  close(): Promise<void>;
}

/** Serve one build directory at the root of its own loopback origin, read-only. */
export async function serveDirectory(root: string, virtual: Record<string, string> = {}): Promise<StaticOrigin> {
  const server: Server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    if (Object.hasOwn(virtual, path)) {
      response.writeHead(200, { "content-type": TYPES[".html"]!, "cache-control": "no-store" }).end(virtual[path]);
      return;
    }
    const file = normalize(join(root, path === "/" ? "index.html" : path));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

export async function launchWebKit(): Promise<Browser> {
  return webkit.launch();
}

export interface LaneOptions {
  readonly state: StateName | QaState;
  readonly colorScheme?: "light" | "dark";
  readonly viewport?: { width: number; height: number };
  readonly reducedMotion?: "reduce" | "no-preference";
  /** The device screen (window.screen) the pages see; defaults to the viewport. */
  readonly screen?: { width: number; height: number };
}

export type AppEntry = "shipped" | "emitted-chunk";

/** The diagnostic entry described on Lane.appUrl, built from the shipped page. */
export function emittedChunkEntry(root: string = APPLE_WEBVIEW): string | null {
  const assets = join(root, "assets");
  if (!existsSync(assets)) return null;
  const script = readdirSync(assets).find((f) => f.endsWith(".js"));
  const style = readdirSync(assets).find((f) => f.endsWith(".css"));
  if (!script || !style) return null;
  const shipped = readFileSync(join(root, "index.html"), "utf8");
  const inlineScript = /<script type="module">[\s\S]*?<\/script>/;
  const inlineStyle = /<style>[\s\S]*?<\/style>/;
  if (!inlineScript.test(shipped) || !inlineStyle.test(shipped)) return null;
  return shipped
    .replace(inlineScript, () => `<script type="module" src="./assets/${script}"></script>`)
    .replace(inlineStyle, () => `<link rel="stylesheet" href="./assets/${style}">`);
}

export interface Lane {
  readonly context: BrowserContext;
  readonly model: NativeModel;
  readonly extensionOrigin: string;
  readonly appOrigin: string;
  /** URL of a built Safari extension page ("popup" | "options"). */
  safariUrl(page: "popup" | "options"): string;
  /**
   * URL of the built Apple web view. "shipped" (default) is dist/index.html, the single file the
   * app bundles. "emitted-chunk" is a DIAGNOSTIC entry: the same index.html with its inlined
   * module and stylesheet swapped for the identical-source files Vite also emitted under
   * dist/assets. Never a verdict: it only shows what the shipped page would render if its
   * inlining step kept Vite's final chunk (see README, "Findings").
   */
  appUrl(entry?: AppEntry): string;
  /** Open a page directly (not framed) at the context viewport. */
  open(url: string): Promise<Page>;
  close(): Promise<void>;
}

/**
 * One WebKit context at deviceScaleFactor 2 with the shim installed in every frame and the given
 * recorded state behind it. Each lane has its own NativeModel (its own App Group).
 */
export async function openLane(browser: Browser, options: LaneOptions): Promise<Lane> {
  const state = typeof options.state === "string" ? STATES[options.state] : options.state;
  const model = await NativeModel.create(state);
  const extension = await serveDirectory(SAFARI_EXTENSION);
  const diagnostic = emittedChunkEntry();
  const app = await serveDirectory(APPLE_WEBVIEW, diagnostic ? { "/__qa-emitted-chunk.html": diagnostic } : {});
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    colorScheme: options.colorScheme ?? "light",
    reducedMotion: options.reducedMotion ?? "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    viewport: options.viewport ?? { width: 420, height: 900 },
  });
  await context.clock.setFixedTime(QA_CLOCK);
  await context.exposeBinding("__stillQaBoundary", (source, surface: string, message: unknown) =>
    model.handle(surface as Parameters<NativeModel["handle"]>[0], source.frame.url(), message),
  );
  // The background's projection of the App Group record, as browser.storage.local holds it.
  const record = model.currentRecord();
  await context.addInitScript(installBoundaryShim, {
    marker: BOUNDARY_SHIM_MARKER,
    extensionOrigin: extension.origin,
    appOrigin: app.origin,
    extensionHost: EXTENSION_HOST,
    platform: state.platform,
    storage: record ? { "still:settings": record } : {},
    ...(options.screen ? { screen: options.screen } : {}),
  });
  return {
    context,
    model,
    extensionOrigin: extension.origin,
    appOrigin: app.origin,
    safariUrl: (page) => `${extension.origin}/${page}.html`,
    appUrl: (entry = "shipped") => {
      if (entry === "shipped") return `${app.origin}/index.html`;
      if (!diagnostic) throw new Error(`${APPLE_WEBVIEW} has no emitted chunk to diagnose with`);
      return `${app.origin}/__qa-emitted-chunk.html`;
    },
    async open(url) {
      const page = await context.newPage();
      await page.goto(url);
      await page.evaluate(() => document.fonts.ready);
      return page;
    },
    async close() {
      await context.close();
      await Promise.all([extension.close(), app.close()]);
    },
  };
}

export { STATES, type QaState, type StateName };
