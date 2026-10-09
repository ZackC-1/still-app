import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The built bundles name their own host. Still Pro extras count only on a host that implements
// them (access-policy.ts IMPLEMENTED_PRO_FEATURES), so each build's content script must hand its
// host to the content entry, and its background must resolve the access context for that same
// host. Without this, deleting `host:` (or the background's argument) would leave Chromium/Firefox
// extras silently inert once paid is on, and no behavioural test can see it while paid is off.
//
// Reads the build output only (no browser), so it runs identically in both CI lanes.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUILDS = [
  { host: "chromium", dir: "packages/ext-chromium/dist/chrome-mv3", pages: ["popup", "options", "first-run"] },
  { host: "firefox", dir: "packages/ext-chromium/dist/firefox-mv3", pages: ["popup", "options", "first-run"] },
  { host: "safari", dir: "packages/ext-safari/dist/safari-mv3", pages: ["popup", "options"] },
] as const;
const HOSTS = BUILDS.map((build) => build.host);
const quoted = (value: string) => `[\`"']${value}[\`"']`;
/** The content entry's options object carries `host: "<host>"` (minifiers keep the key). */
const contentHost = (host: string) => new RegExp(`\\bhost:\\s*${quoted(host)}`, "g");
/** The background calls packagedAccessContext("<host>"[, platform]): the host, then at most the
 * runtime platform answer (a plain or awaited identifier; the hosts that span phones pass it). */
const backgroundHost = (host: string) => new RegExp(`[\\w$]+\\(\\s*${quoted(host)}\\s*(?:,\\s*(?:await\\s+)?[\\w$.]+\\s*)?\\)`, "g");
const read = (dir: string, file: string) => readFileSync(resolve(ROOT, dir, file), "utf8");
/** A page's options name its access host: `accessHost: "<host>"` (minifiers keep the key). */
const pageHost = (host: string) => new RegExp(`\\baccessHost:\\s*${quoted(host)}`, "g");
/** The one hashed chunk a page entry builds into (chunks/<page>-<hash>.js). */
function pageChunk(dir: string, page: string): string {
  const names = readdirSync(resolve(ROOT, dir, "chunks")).filter((name) => new RegExp(`^${page}-[\\w-]{8}\\.js$`).test(name));
  expect(names, `${dir} ${page} chunk`).toHaveLength(1);
  return read(dir, `chunks/${names[0]}`);
}

for (const { host, dir } of BUILDS)
  test(`${dir.split("/").slice(-1)[0]} content and background name the ${host} host, and only it`, () => {
    const content = read(dir, "content-scripts/content.js");
    const background = read(dir, "background.js");
    expect(content.match(contentHost(host)), "content entry host").toHaveLength(1);
    expect(background.match(backgroundHost(host)), "background access context host").toHaveLength(1);
    for (const other of HOSTS.filter((name) => name !== host)) {
      expect(content.match(contentHost(other)), `content never names ${other}`).toBeNull();
      expect(background.match(backgroundHost(other)), `background never resolves ${other}`).toBeNull();
    }
  });

// The popup, options and first-run pages seed their access snapshot for their own host too
// (extension-setup.ts accessHost). A host-less page would show a Chromium/Firefox Still Pro extra
// as "Not available in this browser" once paid is on, until (or unless) the background answered.
for (const { host, dir, pages } of BUILDS)
  for (const page of pages)
    test(`${dir.split("/").slice(-1)[0]} ${page} page names the ${host} access host, and only it`, () => {
      const chunk = pageChunk(dir, page);
      expect(chunk.match(pageHost(host)), `${page} access host`).toHaveLength(1);
      for (const other of HOSTS.filter((name) => name !== host)) expect(chunk.match(pageHost(other)), `never ${other}`).toBeNull();
    });

// The early Shorts redirect (Firefox and Safari have no network-layer redirect) decides with the
// same host-aware capabilities as the content script: each early-redirect call carries
// `capabilities: <ctx>.supported`, where <ctx> is the context resolved from the entry's own host
// (`<ctx> = packagedAccessContext(deps.host, deps.platform)`), and the entry's host is the build's
// own (checked above).
const hostContexts = (content: string) =>
  new Set([...content.matchAll(/([\w$]+)=[\w$]+\(([\w$]+)\.host,\2\.platform\)/g)].map((match) => match[1]!));
const earlyRedirectCalls = (content: string) =>
  [...content.matchAll(/\{win:[^{}]*?access:\(\)=>[^{}]*?redirectDedupe:[\w$]+\}/g)].map((match) => match[0]);

for (const { host, dir } of BUILDS)
  test(`${dir.split("/").slice(-1)[0]} early Shorts redirect receives the ${host} host's capabilities`, () => {
    const content = read(dir, "content-scripts/content.js");
    const contexts = hostContexts(content);
    expect(contexts.size, "host-aware access contexts").toBeGreaterThan(0);
    const calls = earlyRedirectCalls(content);
    expect(calls, "format-2 early redirect calls (entry and shipping lane)").toHaveLength(2);
    for (const call of calls) {
      const passed = call.match(/capabilities:([\w$]+)\.supported/)?.[1];
      expect(passed && contexts.has(passed), `capabilities from a host-aware context: ${call}`).toBe(true);
    }
  });
