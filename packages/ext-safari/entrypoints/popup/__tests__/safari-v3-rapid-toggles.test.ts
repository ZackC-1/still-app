import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { unmount } from "svelte";
import { requireModernSettings } from "@still/core/storage";
import { startSafariV3Popup } from "../v3.js";
import { installSafari, type SafariHostBehavior } from "./safari-native.fixture.js";

// ISS-0050: on both Safari popups (Mac signed out, iPhone signed in) three or four quick taps on a
// site blocker or the main switch froze every switch with "Settings are unavailable." until a
// background read a few seconds later, and Try again did nothing visible. The native Mac app, whose
// web view talks to the same store through an in-process handler, never froze.
//
// These tests drive the real Safari V3 popup (composition, cache, adapter and binding) against a
// synthetic native host that answers like the app's SafariWebExtensionHandler: page reads go to
// the host directly, replies take time, and the host refuses a page's second settings message
// while an earlier one is still outstanding.

const mounted = vi.hoisted(() => ({ instances: [] as Record<string, unknown>[] }));
vi.mock("svelte", async (importOriginal) => {
  const real = await importOriginal<typeof import("svelte")>();
  return {
    ...real,
    mount: (component: Parameters<typeof real.mount>[0], options: Parameters<typeof real.mount>[1]) => {
      const instance = real.mount(component, options);
      mounted.instances.push(instance);
      return instance;
    },
  };
});

const ENV = { atomicSettingsFlag: "true", modernSyncFlag: undefined, supabaseUrl: undefined, supabaseAnonKey: undefined };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const UNAVAILABLE = "Settings are unavailable.";

afterEach(async () => {
  for (const instance of mounted.instances.splice(0)) await unmount(instance);
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Account = "signed-out" | "signed-in";
type Saved = ReturnType<typeof requireModernSettings>;
type Target = { readonly name: string; readonly read: (settings: Saved) => boolean };
const YOUTUBE: Target = { name: "Still on YouTube", read: (s) => s.services.youtube };
const MAIN: Target = { name: "Still", read: (s) => s.globalOn };

async function open(account: Account, host: SafariHostBehavior, platform = "mac") {
  const f = await installSafari({ saved: "atomic", platform, account, nativeReads: true, host });
  document.body.innerHTML = '<div id="app"></div>';
  expect(await startSafariV3Popup({ env: ENV })).toBe("v3");
  const main = await screen.findByRole("switch", { name: "Still" });
  await waitFor(() => expect(main.getAttribute("aria-disabled")).toBeNull());
  const before = requireModernSettings((await f.nativeRecord())!);
  return { f, before };
}

/** Samples the screen every 5 ms and counts any moment the popup shows a hold. */
function watchForHolds(target: Target) {
  let holds = 0;
  const timer = setInterval(() => {
    const unavailable = document.body.textContent?.includes(UNAVAILABLE) ?? false;
    const main = screen.queryByRole("switch", { name: "Still" })?.getAttribute("aria-disabled") === "true";
    const own = screen.queryByRole("switch", { name: target.name })?.getAttribute("aria-disabled") === "true";
    if (unavailable || main || (target !== MAIN && own)) holds += 1;
  }, 5);
  return { stop: () => { clearInterval(timer); return holds; } };
}

/** Taps `count` times evenly inside about one second; returns what the last tap asked for. */
async function tapQuickly(target: Target, count: number): Promise<boolean> {
  let last = false;
  const gap = Math.floor(900 / count);
  for (let i = 0; i < count; i++) {
    const control = screen.getByRole("switch", { name: target.name });
    expect(control.getAttribute("aria-disabled"), `tap ${i + 1} found the switch held`).toBeNull();
    last = control.getAttribute("aria-checked") !== "true";
    await fireEvent.click(control);
    await sleep(gap);
  }
  return last;
}

/** Every saved choice except the one the test taps. */
function untouched(saved: Saved, target: Target) {
  const { youtube: _youtube, ...services } = saved.services;
  return target === MAIN ? { services: saved.services, sites: saved.sites } : { globalOn: saved.globalOn, services, sites: saved.sites };
}

const OVERLAP: SafariHostBehavior = { latencyMs: () => 120, busy: "reject" };

describe("Safari popup: quick taps while the native host answers one message at a time (ISS-0050)", () => {
  for (const account of ["signed-out", "signed-in"] as const)
    for (const target of [YOUTUBE, MAIN])
      for (const count of [3, 5, 10])
        it(`${account}: ${count} taps on "${target.name}" inside a second stay responsive and the last tap wins`, async () => {
          const { f, before } = await open(account, OVERLAP, account === "signed-in" ? "ios" : "mac");
          const watch = watchForHolds(target);
          const last = await tapQuickly(target, count);
          // Every tap is answered; the screen settles on the last choice.
          await waitFor(
            () => expect(screen.getByRole("switch", { name: target.name }).getAttribute("aria-checked")).toBe(String(last)),
            { timeout: 4_000 },
          );
          await sleep(300);
          expect(watch.stop(), "the popup showed a hold or Settings are unavailable.").toBe(0);
          expect(document.body.textContent).not.toContain(UNAVAILABLE);
          const saved = requireModernSettings((await f.nativeRecord())!);
          expect(target.read(saved)).toBe(last);
          // Nothing else moved: no reset, no replayed choice on another field.
          expect(untouched(saved, target)).toEqual(untouched(before, target));
          // At most one native intent per tap: an unanswered intent is never sent again.
          expect(f.nativeKinds().filter((k) => k === "settingsIntent").length).toBeLessThanOrEqual(count);
          // The page never overlapped its own settings messages.
          expect(f.busyRefusals).toEqual([]);
        }, 15_000);
});

describe("Safari popup: delayed and out-of-order native replies", () => {
  // The first reply is the slowest, so a tolerant host would answer out of order.
  const latencies = [260, 40, 180, 20, 120, 60, 220, 10];
  for (const account of ["signed-out", "signed-in"] as const)
    it(`${account}: 5 quick YouTube taps end on the last tap, with no hold and no replay`, async () => {
      let n = 0;
      const { f, before } = await open(account, { latencyMs: () => latencies[n++ % latencies.length]! });
      const watch = watchForHolds(YOUTUBE);
      const last = await tapQuickly(YOUTUBE, 5);
      await waitFor(
        () => expect(screen.getByRole("switch", { name: YOUTUBE.name }).getAttribute("aria-checked")).toBe(String(last)),
        { timeout: 4_000 },
      );
      await sleep(300);
      expect(watch.stop()).toBe(0);
      const saved = requireModernSettings((await f.nativeRecord())!);
      expect(saved.services.youtube).toBe(last);
      expect(untouched(saved, YOUTUBE)).toEqual(untouched(before, YOUTUBE));
      expect(f.nativeKinds().filter((k) => k === "settingsIntent").length).toBeLessThanOrEqual(5);
    }, 15_000);
});

describe("Safari popup: Try again", () => {
  async function heldAfterUnreachableTap() {
    const opened = await open("signed-out", { latencyMs: () => 30 });
    // The app is briefly unreachable: the tap's outcome is unknown, so the popup holds.
    opened.f.setNativeDown(true);
    await fireEvent.click(screen.getByRole("switch", { name: YOUTUBE.name }));
    await waitFor(() => expect(screen.getByText(UNAVAILABLE)).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" }).hasAttribute("disabled")).toBe(false));
    // A person reads the message before pressing Try again; the automatic read has settled.
    await sleep(100);
    return { ...opened, intents: opened.f.nativeKinds().filter((k) => k === "settingsIntent").length };
  }

  it("clears the hold at once when the app answers again, by reading only", async () => {
    const { f, intents } = await heldAfterUnreachableTap();
    f.setNativeDown(false);
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    // Well before the popup's own background read a few seconds later.
    await waitFor(() => expect(screen.queryByText(UNAVAILABLE)).toBeNull(), { timeout: 1_000 });
    expect(screen.getByRole("switch", { name: "Still" }).getAttribute("aria-disabled")).toBeNull();
    expect(f.nativeKinds().filter((k) => k === "settingsIntent")).toHaveLength(intents);
  });

});
