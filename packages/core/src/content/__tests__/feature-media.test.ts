import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type SignedRuleSet } from "@still/shared-types";
import { createContentScript, type ContentScriptHandle } from "../index.js";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { createEnginePageSession } from "../../rules/engine.js";
import {
  ruleSet,
  on,
  access,
  capabilities,
  url,
} from "../../rules/__tests__/format2-fixtures.js";
import seed from "../../../rules/seed.json";
import { createFeatureMediaQuieting } from "../feature-media.js";
const scripts: ContentScriptHandle[] = [];
afterEach(() => {
  for (const s of scripts.splice(0)) s.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});
function player(id: string) {
  const el = document.getElementById(id) as HTMLVideoElement;
  let playing = true;
  Object.defineProperty(el, "paused", { get: () => !playing });
  Object.defineProperty(el, "ended", { get: () => false });
  const pause = vi.spyOn(el, "pause").mockImplementation(() => {
    playing = false;
    el.dispatchEvent(new Event("pause"));
  });
  const play = vi.spyOn(el, "play").mockImplementation(async () => {
    playing = true;
    el.dispatchEvent(new Event("play"));
  });
  return { el, pause, play };
}
async function host() {
  const store = new InMemoryStorageAdapter({
    ...DEFAULT_SETTINGS,
    updatedAt: 1,
  });
  const writer = new AtomicSettingsWriter(store);
  await writer.initialize("never-linked");
  const cache = new SettingsCache(store);
  const script = createContentScript({
    win: {
      location: { href: url.href, replace: vi.fn() },
      history: { pushState: vi.fn(), replaceState: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      MutationObserver: window.MutationObserver,
    },
    doc: document,
    ruleSet: seed as unknown as SignedRuleSet,
    ruleSetV2: ruleSet,
    cache,
  });
  scripts.push(script);
  await script.start();
  return { script, writer };
}
describe("owned modern hidden media", () => {
  it("construction and Off own no media listeners; activation and stop attach and release exactly once", () => {
    const add = vi.spyOn(document, "addEventListener"),
      remove = vi.spyOn(document, "removeEventListener");
    let key = "";
    const helper = createFeatureMediaQuieting({
      doc: document,
      activeKey: () => key,
      isHidden: () => false,
    });
    helper.reconcile();
    expect(add).not.toHaveBeenCalled();
    key = "active";
    helper.reconcile();
    expect(add).toHaveBeenCalledTimes(6);
    helper.reconcile();
    expect(add).toHaveBeenCalledTimes(6);
    key = "";
    helper.reconcile();
    expect(remove).toHaveBeenCalledTimes(6);
    helper.stop();
    helper.reconcile();
    expect(remove).toHaveBeenCalledTimes(6);
  });
  it("quiets already-playing owned hidden media, preserves allowed player and never restarts on Off", async () => {
    document.body.innerHTML =
      '<div class="shorts"><video id="hidden"></video></div><div class="shorts"><div class="preserve"><video id="preserved"></video></div></div><video id="ordinary"></video>';
    const hidden = player("hidden"),
      preserved = player("preserved"),
      ordinary = player("ordinary");
    const h = await host();
    expect(hidden.pause).toHaveBeenCalledOnce();
    expect(preserved.pause).not.toHaveBeenCalled();
    expect(ordinary.pause).not.toHaveBeenCalled();
    await h.writer.commit({
      path: "sites.youtube.shorts",
      value: false,
      updatedAt: 2,
    });
    expect(hidden.play).not.toHaveBeenCalled();
    expect(hidden.el.isConnected).toBe(true);
    expect(getComputedStyle(hidden.el.parentElement!).display).not.toBe("none");
  });
  it("quieting follows a recycled playing card without a document scan or observer", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<div id="card" class="recycled" data-kind="normal"><video id="video"></video></div>';
    const video = player("video");
    const h = await host();
    expect(video.pause).not.toHaveBeenCalled();
    const query = vi.spyOn(document, "querySelectorAll");
    document.getElementById("card")!.setAttribute("data-kind", "short");
    await vi.advanceTimersByTimeAsync(100);
    expect(video.pause).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    h.script.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("the matcher uses the same effective plan and actual owned CSS, including every comma branch", () => {
    document.body.innerHTML =
      '<div class="comments-second"><video id="video"></video></div>';
    const session = createEnginePageSession(ruleSet);
    const media = document.getElementById("video")!;
    session.applyDom(on, url, document, { access, capabilities });
    expect(
      (
        session as typeof session & {
          ownsHiddenMedia?: (node: Element) => boolean;
        }
      ).ownsHiddenMedia?.(media),
    ).toBe(true);
    session.applyDom({ ...on, globalOn: false }, url, document, {
      access,
      capabilities,
    });
    expect(
      (
        session as typeof session & {
          ownsHiddenMedia?: (node: Element) => boolean;
        }
      ).ownsHiddenMedia?.(media),
    ).toBe(false);
    session.stop?.();
  });
  it("site-only hidden media and player preferences are preserved, and a native retry is promptly quieted", async () => {
    document.body.innerHTML =
      '<div style="display:none"><video id="site"></video></div><div class="shorts"><video id="owned" controls muted></video></div>';
    const site = player("site"),
      owned = player("owned");
    owned.el.volume = 0.37;
    owned.el.playbackRate = 1.5;
    owned.el.currentTime = 7;
    const attributes = owned.el.outerHTML;
    const listener = vi.fn();
    owned.el.addEventListener("still-fixture", listener);
    const h = await host();
    expect(site.pause).not.toHaveBeenCalled();
    await owned.play();
    expect(owned.pause).toHaveBeenCalledTimes(2);
    expect(owned.el.outerHTML).toBe(attributes);
    expect(owned.el.volume).toBe(0.37);
    expect(owned.el.playbackRate).toBe(1.5);
    expect(owned.el.currentTime).toBe(7);
    owned.el.dispatchEvent(new Event("still-fixture"));
    expect(listener).toHaveBeenCalledOnce();
    await h.writer.commit({ path: "globalOn", value: false, updatedAt: 2 });
    await owned.play();
    expect(owned.pause).toHaveBeenCalledTimes(2);
    expect(owned.el.paused).toBe(false);
  });
  it("unsupported/held feature or missing actual owned stylesheet never grants a pause", () => {
    document.body.innerHTML =
      '<div class="shorts"><video id="video"></video></div>';
    const s = createEnginePageSession(ruleSet);
    const media = document.getElementById("video")!;
    s.applyDom(on, url, document, { access, capabilities: new Set() });
    expect(s.ownsHiddenMedia?.(media)).toBe(false);
    s.applyDom(on, url, document, {
      access: {
        ...access,
        states: { ...access.states, "youtube.shorts": "checking" },
      },
      capabilities,
    });
    expect(s.ownsHiddenMedia?.(media)).toBe(false);
    s.applyDom(on, url, document, { access, capabilities });
    expect(s.ownsHiddenMedia?.(media)).toBe(true);
    const sheet = document.querySelector('style')!.sheet!;
    sheet.disabled = true; expect(s.ownsHiddenMedia?.(media)).toBe(false); expect(s.activeMediaKey?.()).toBe(''); sheet.disabled = false;
    document.querySelector("style")!.remove();
    expect(s.ownsHiddenMedia?.(media)).toBe(false);
    s.stop?.();
  });
  it("bounds retained players, setup, flush and timer; disconnect and terminal stop clear them", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = Array.from(
      { length: 100 },
      (_, i) => `<video id="v${i}"></video>`,
    ).join("");
    for (let i = 0; i < 100; i++) player(`v${i}`);
    const helper = createFeatureMediaQuieting({
      doc: document,
      activeKey: () => "fixture-active",
      isHidden: () => false,
    });
    helper.reconcile();
    expect(helper.debugStats()).toMatchObject({
      retainedPlayers: 32,
      setupVisited: 64,
      timerPending: true,
    });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(helper.debugStats().lastFlushChecked).toBe(8);
    expect(vi.getTimerCount()).toBe(1);
    document.body.innerHTML = "";
    await vi.advanceTimersByTimeAsync(100);
    expect(helper.debugStats().retainedPlayers).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    helper.stop();
    helper.reconcile();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a native media event can quiet a hidden overflow player without retaining it or rescanning", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = Array.from(
      { length: 70 },
      (_, i) => `<video id="v${i}"></video>`,
    ).join("");
    const players = Array.from({ length: 70 }, (_, i) => player(`v${i}`));
    let hidden = false;
    const helper = createFeatureMediaQuieting({
      doc: document,
      activeKey: () => "fixture-active",
      isHidden: (media) => hidden && media.id === "v69",
    });
    helper.reconcile();
    const query = vi.spyOn(document, "getElementsByTagName");
    hidden = true;
    players[69]!.el.dispatchEvent(new Event("timeupdate"));
    expect(players[69]!.pause).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(helper.debugStats().retainedPlayers).toBeLessThanOrEqual(32);
    helper.stop();
    expect(helper.debugStats()).toMatchObject({
      retainedPlayers: 0,
      timerPending: false,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a busy setup and flush yield after the existing two-millisecond budget", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = Array.from(
      { length: 12 },
      (_, i) => `<video id="budget${i}"></video>`,
    ).join("");
    for (let i = 0; i < 12; i++) player(`budget${i}`);
    let calls = 0;
    const clock = vi
      .spyOn(window.performance, "now")
      .mockImplementation(() => (calls++ < 2 ? 0 : 3));
    const helper = createFeatureMediaQuieting({
      doc: document,
      activeKey: () => "fixture-active",
      isHidden: () => false,
    });
    helper.reconcile();
    expect(helper.debugStats().setupVisited).toBe(1);
    helper.stop();
    clock.mockRestore();
    const flush = createFeatureMediaQuieting({
      doc: document,
      activeKey: () => "fixture-active",
      isHidden: () => false,
    });
    flush.reconcile();
    calls = 0;
    const secondClock = vi
      .spyOn(window.performance, "now")
      .mockImplementation(() => (calls++ < 2 ? 0 : 3));
    await vi.advanceTimersByTimeAsync(25);
    expect(flush.debugStats().lastFlushChecked).toBe(1);
    flush.stop();
    secondClock.mockRestore();
    expect(vi.getTimerCount()).toBe(0);
  });
});
