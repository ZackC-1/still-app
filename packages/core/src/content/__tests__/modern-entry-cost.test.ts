import { afterEach, describe, expect, it, vi } from "vitest";
import * as engine from "../../rules/engine.js";
import type { ContentScriptHandle } from "../index.js";
import { createCoreRouteClassifier, createModernShippingContentEntry, mayBeCoreRoute } from "../modern-shipping-entry.js";
import { createFormat2EntryHost } from "./format2-entry-host.js";
import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../../rules/packaged.js";

// U7-W3 review P2: document_start must stay cheap on ordinary pages. The engine-backed core-route
// classifier costs milliseconds to build cold, so it is built only behind mayBeCoreRoute.

vi.mock("../../rules/engine.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../rules/engine.js")>();
  return { ...original, createEnginePageSession: vi.fn(original.createEnginePageSession) };
});
const sessions = vi.mocked(engine.createEnginePageSession);

const scripts: ContentScriptHandle[] = [];
afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

const FIXTURE: Record<string, string> = {
  "www.youtube.com": "youtube.html",
  "m.youtube.com": "youtube-mobile.html",
  "www.instagram.com": "instagram-home.html",
  "www.facebook.com": "facebook.html",
};

/** Engine sessions built during the synchronous document_start part of the entry. */
async function sessionsAtDocumentStart(href: string): Promise<number> {
  const h = await createFormat2EntryHost(PACKAGED_RULE_SET_V2 as never, FIXTURE[new URL(href).host]!, href, scripts);
  const storage = (globalThis as unknown as { chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } } }).chrome.storage.local;
  sessions.mockClear();
  const loading = createModernShippingContentEntry({
    storage,
    prod: false,
    earlyRedirect: true,
    pendingCover: true,
    win: h.win,
    doc: document,
    onScriptCreated: (script) => scripts.push(script),
  })();
  const atStart = sessions.mock.calls.length;
  await loading;
  return atStart;
}

const ORDINARY = [
  "https://www.youtube.com/",
  "https://www.youtube.com/watch?v=abc123",
  "https://m.youtube.com/results?search_query=x",
  "https://www.instagram.com/",
  "https://www.instagram.com/someone/",
  "https://www.instagram.com/explore/",
  "https://www.instagram.com/reel/C0de12/",
  "https://www.facebook.com/",
  "https://www.facebook.com/watch/",
  "https://www.facebook.com/somepage/reels/",
];
const CANDIDATES = [
  "https://www.youtube.com/shorts/abc123",
  "https://www.instagram.com/reels/",
  "https://www.instagram.com/reels/C0de12/",
  "https://www.facebook.com/watch/reels/",
];

describe("document_start cost of the V3 entry", () => {
  it.each(ORDINARY)("%s builds no engine session at document_start", async (href) => {
    expect(await sessionsAtDocumentStart(href)).toBe(0);
  });

  it.each(CANDIDATES)("%s builds exactly one (the classifier)", async (href) => {
    expect(await sessionsAtDocumentStart(href)).toBe(1);
  });
});

describe("mayBeCoreRoute never rules out a route the engine sends elsewhere", () => {
  const classify = createCoreRouteClassifier(admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!);
  const hosts = ["www.youtube.com", "m.youtube.com", "youtube.com", "www.instagram.com", "www.facebook.com", "m.facebook.com", "www.tiktok.com"];
  const paths = [
    "/", "/shorts", "/shorts/", "/shorts/abc123", "/shorts/abc123/", "/shorts/abc123?t=4", "/shorts/a/b",
    "/reels", "/reels/", "/reels/C0de12", "/reels/C0de12/", "/reels/audio/1/", "/reel/C0de12/", "/someone/reels/",
    "/watch", "/watch/", "/watch/reels", "/watch/reels/", "/watch?v=abc", "/watch/live/", "/explore/", "/stories/x/1/",
    "/popular/cats/", "/results?search_query=shorts", "/@channel/shorts", "/REELS/", "//reels/",
  ];
  const corpus = hosts.flatMap((host) => paths.map((path) => new URL(`https://${host}${path}`)));

  it("is a necessary condition over the whole corpus", () => {
    const missed = corpus.filter((url) => classify(url) !== null && !mayBeCoreRoute(url)).map((url) => url.href);
    expect(missed).toEqual([]);
    // The corpus does contain core routes, so the check above is not vacuous.
    expect(corpus.filter((url) => classify(url) !== null).length).toBeGreaterThanOrEqual(8);
  });
});
