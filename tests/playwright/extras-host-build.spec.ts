import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
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
  { host: "chromium", dir: "packages/ext-chromium/dist/chrome-mv3" },
  { host: "firefox", dir: "packages/ext-chromium/dist/firefox-mv3" },
  { host: "safari", dir: "packages/ext-safari/dist/safari-mv3" },
] as const;
const HOSTS = BUILDS.map((build) => build.host);
const quoted = (value: string) => `[\`"']${value}[\`"']`;
/** The content entry's options object carries `host: "<host>"` (minifiers keep the key). */
const contentHost = (host: string) => new RegExp(`\\bhost:\\s*${quoted(host)}`, "g");
/** The background calls packagedAccessContext("<host>"): a call whose only argument is the host. */
const backgroundHost = (host: string) => new RegExp(`[\\w$]+\\(\\s*${quoted(host)}\\s*\\)`, "g");
const read = (dir: string, file: string) => readFileSync(resolve(ROOT, dir, file), "utf8");

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
