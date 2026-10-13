import { describe, expect, it, vi } from "vitest";
import {
  SYNC_ROUTE_ACCOUNT_WAIT_MS,
  createAppleAppRoutes,
  createAppleSyncRoute,
  revealAppleSyncCard,
  revealAppleSyncCardWhenRendered,
} from "./apple-sync-route.js";
import type { NativeAppRoute } from "../../native/bridge.js";

function harness(pending: NativeAppRoute | null, signedOut = true) {
  const calls: string[] = [];
  const deps = {
    bridge: {
      pendingAppRoute: vi.fn(async () => pending),
      acknowledgeAppRoute: vi.fn(async (revision: number) => {
        calls.push(`ack:${revision}`);
        return true;
      }),
    },
    showSettings: vi.fn(() => void calls.push("settings")),
    canSignIn: vi.fn(() => signedOut),
    openSignIn: vi.fn(() => void calls.push("signIn")),
    reveal: vi.fn((focus: boolean) => void calls.push(`reveal:${focus}`)),
  };
  return { route: createAppleSyncRoute(deps), deps, calls };
}

describe("createAppleSyncRoute", () => {
  it("signed out: shows Settings, opens sign-in over the sync card, then acknowledges", async () => {
    const { route, calls } = harness({ route: "sync", revision: 4 });
    await route.route();
    expect(calls).toEqual(["settings", "signIn", "reveal:false", "ack:4"]);
  });

  it("signed in: shows the sync card with its status and opens nothing else", async () => {
    const { route, deps, calls } = harness({ route: "sync", revision: 2 }, false);
    await route.route();
    expect(deps.openSignIn).not.toHaveBeenCalled();
    expect(calls).toEqual(["settings", "reveal:true", "ack:2"]);
  });

  it("leaves the Still Pro route pending for the Pro host", async () => {
    const { route, deps } = harness({ route: "pro", revision: 9 });
    await route.route();
    expect(deps.showSettings).not.toHaveBeenCalled();
    expect(deps.openSignIn).not.toHaveBeenCalled();
    expect(deps.bridge.acknowledgeAppRoute).not.toHaveBeenCalled();
  });

  it("does nothing with no pending route or after stop", async () => {
    const empty = harness(null);
    await empty.route.route();
    expect(empty.calls).toEqual([]);
    const stopped = harness({ route: "sync", revision: 1 });
    stopped.route.stop();
    await stopped.route.route();
    expect(stopped.calls).toEqual([]);
  });
});

describe("createAppleSyncRoute waits for the launch's account resume", () => {
  it("a saved session restored during the wait is treated as signed in", async () => {
    let signedOut = true;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const openSignIn = vi.fn();
    const reveal = vi.fn();
    const acknowledgeAppRoute = vi.fn(async () => true);
    const route = createAppleSyncRoute({
      bridge: { pendingAppRoute: async () => ({ route: "sync", revision: 3 }), acknowledgeAppRoute },
      showSettings: () => {},
      accountSettled: () => settled,
      canSignIn: () => signedOut,
      openSignIn,
      reveal,
      wait: () => new Promise(() => {}),
    });
    const done = route.route();
    await Promise.resolve();
    expect(acknowledgeAppRoute).not.toHaveBeenCalled();
    signedOut = false;
    settle();
    await done;
    expect(openSignIn).not.toHaveBeenCalled();
    expect(reveal).toHaveBeenCalledWith(true);
    expect(acknowledgeAppRoute).toHaveBeenCalledWith(3);
  });

  it("a resume that never settles is waited for only a bounded time", async () => {
    const waits: number[] = [];
    const openSignIn = vi.fn();
    const route = createAppleSyncRoute({
      bridge: { pendingAppRoute: async () => ({ route: "sync", revision: 1 }), acknowledgeAppRoute: async () => true },
      showSettings: () => {},
      accountSettled: () => new Promise(() => {}),
      canSignIn: () => true,
      openSignIn,
      reveal: () => {},
      wait: async (ms) => void waits.push(ms),
    });
    await route.route();
    expect(waits).toEqual([SYNC_ROUTE_ACCOUNT_WAIT_MS]);
    expect(openSignIn).toHaveBeenCalledOnce();
  });

  it("a failed resume still lets the route land", async () => {
    const openSignIn = vi.fn();
    const route = createAppleSyncRoute({
      bridge: { pendingAppRoute: async () => ({ route: "sync", revision: 1 }), acknowledgeAppRoute: async () => true },
      showSettings: () => {},
      accountSettled: () => Promise.reject(new Error("offline")),
      canSignIn: () => true,
      openSignIn,
      reveal: () => {},
      wait: () => new Promise(() => {}),
    });
    await route.route();
    expect(openSignIn).toHaveBeenCalledOnce();
  });

  it("a route stopped during the wait does nothing", async () => {
    let settle!: () => void;
    const showSettings = vi.fn();
    const acknowledgeAppRoute = vi.fn(async () => true);
    const route = createAppleSyncRoute({
      bridge: { pendingAppRoute: async () => ({ route: "sync", revision: 1 }), acknowledgeAppRoute },
      showSettings,
      accountSettled: () => new Promise<void>((resolve) => (settle = resolve)),
      canSignIn: () => true,
      openSignIn: () => {},
      reveal: () => {},
      wait: () => new Promise(() => {}),
    });
    const done = route.route();
    await Promise.resolve();
    route.stop();
    settle();
    await done;
    expect(showSettings).not.toHaveBeenCalled();
    expect(acknowledgeAppRoute).not.toHaveBeenCalled();
  });
});

describe("createAppleAppRoutes", () => {
  function routes(sequence: Array<{ route: "pro" | "sync"; revision: number } | null>, withPro = true) {
    const reads = [...sequence];
    const bridge = {
      pendingAppRoute: vi.fn(async () => reads.shift() ?? null),
      acknowledgeAppRoute: vi.fn(async () => true),
    };
    const pro = { route: vi.fn(async () => {}) };
    const sync = { route: vi.fn(async () => {}), stop: vi.fn() };
    return { bridge, pro, sync, router: createAppleAppRoutes({ bridge, ...(withPro ? { pro } : {}), sync }) };
  }

  it("reads once and hands each route to the one handler it names", async () => {
    const f = routes([{ route: "pro", revision: 1 }, { route: "sync", revision: 2 }]);
    await f.router.route();
    expect(f.pro.route).toHaveBeenCalledWith({ route: "pro", revision: 1 });
    expect(f.sync.route).not.toHaveBeenCalled();
    await f.router.route();
    expect(f.sync.route).toHaveBeenCalledWith({ route: "sync", revision: 2 });
    expect(f.bridge.pendingAppRoute).toHaveBeenCalledTimes(2);
  });

  it("without the Pro host, still://pro stays pending (nothing acknowledges it)", async () => {
    const f = routes([{ route: "pro", revision: 1 }], false);
    await f.router.route();
    expect(f.sync.route).not.toHaveBeenCalled();
    expect(f.bridge.acknowledgeAppRoute).not.toHaveBeenCalled();
  });

  it("a notification during a read runs one more pass, never two overlapping reads", async () => {
    let release!: (value: { route: "sync"; revision: number }) => void;
    const bridge = {
      pendingAppRoute: vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
        .mockResolvedValueOnce({ route: "pro", revision: 5 }),
      acknowledgeAppRoute: vi.fn(async () => true),
    };
    const pro = { route: vi.fn(async () => {}) };
    const sync = { route: vi.fn(async () => {}), stop: vi.fn() };
    const router = createAppleAppRoutes({ bridge, pro, sync });
    const first = router.route();
    const second = router.route();
    expect(bridge.pendingAppRoute).toHaveBeenCalledTimes(1);
    release({ route: "sync", revision: 4 });
    await Promise.all([first, second]);
    expect(bridge.pendingAppRoute).toHaveBeenCalledTimes(2);
    expect(sync.route).toHaveBeenCalledWith({ route: "sync", revision: 4 });
    expect(pro.route).toHaveBeenCalledWith({ route: "pro", revision: 5 });
  });

  it("stop ends routing and stops the sync route", async () => {
    const f = routes([{ route: "sync", revision: 1 }]);
    f.router.stop();
    await f.router.route();
    expect(f.bridge.pendingAppRoute).not.toHaveBeenCalled();
    expect(f.sync.stop).toHaveBeenCalledOnce();
  });
});

describe("revealAppleSyncCard", () => {
  function screen(headings: string[]) {
    const root = document.createElement("div");
    root.innerHTML = headings
      .map((text) => `<section class="card"><h2> ${text} </h2></section>`)
      .join("");
    const scrolled: string[] = [];
    root.querySelectorAll<HTMLElement>("section").forEach((section) => {
      section.scrollIntoView = () => void scrolled.push(section.textContent!.trim());
    });
    document.body.replaceChildren(root);
    return { root, scrolled };
  }

  it("scrolls to the Settings sync card and focuses it when no sheet is open", () => {
    const { root, scrolled } = screen(["Still Pro", "Settings sync", "Help"]);
    expect(revealAppleSyncCard(root, true)).toBe(true);
    expect(scrolled).toEqual(["Settings sync"]);
    expect(document.activeElement?.textContent?.trim()).toBe("Settings sync");
  });

  it("only scrolls under the sign-in sheet, and finds the purchased heading", () => {
    const { root, scrolled } = screen(["Still Pro and sync"]);
    expect(revealAppleSyncCard(root, false)).toBe(true);
    expect(scrolled).toEqual(["Still Pro and sync"]);
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves the screen alone when no sync card is rendered", () => {
    const { root, scrolled } = screen(["Still Pro", "Synchronise later", "Help"]);
    expect(revealAppleSyncCard(root, true)).toBe(false);
    expect(scrolled).toEqual([]);
  });
});

describe("revealAppleSyncCardWhenRendered", () => {
  it("retries until Settings renders the sync card", async () => {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    let tries = 0;
    const found = await revealAppleSyncCardWhenRendered(root, true, {
      wait: async () => {
        tries++;
        if (tries === 3) root.innerHTML = '<section class="card"><h2>Settings sync</h2></section>';
      },
    });
    expect(found).toBe(true);
    expect(tries).toBe(3);
    expect(document.activeElement?.textContent).toBe("Settings sync");
  });

  it("gives up quietly after the last attempt", async () => {
    const root = document.createElement("div");
    const wait = vi.fn(async () => {});
    await expect(revealAppleSyncCardWhenRendered(root, false, { attempts: 4, wait })).resolves.toBe(false);
    expect(wait).toHaveBeenCalledTimes(4);
  });
});
