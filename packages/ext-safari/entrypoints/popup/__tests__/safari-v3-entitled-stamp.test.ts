import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { unmount } from "svelte";
import { ChromeEntitlementAdapter, createEntitlementMessageRouter } from "@still/core/entitlement";
import { BrowserInstallGenerationStore, createEntitlementPull } from "../../../lib/entitlement-pull.js";
import { startSafariV3Options } from "../../options/v3.js";
import { startSafariV3Popup } from "../v3.js";
import { installSafari, UNPROMPTED_WRITES } from "./safari-native.fixture.js";

// PR #284 re-check P3-3. The app can hand the extension an ENTITLED stamp (the getEntitlement pull,
// from an earlier purchase) while the compiled paid flag is off. Nothing about that stamp may show
// a paywall, a price, a Restore link or an unlocked Pro row on the Safari popup or settings page;
// the free controls stay free and usable. The background side is the real thing: the real
// entitlement pull writes the stamp and the real message router answers the pages' benefit reads.

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
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const text = () => document.body.textContent ?? "";
const EXTENSION_PAGE = "safari-web-extension://still/page.html";

afterEach(async () => {
  for (const instance of mounted.instances.splice(0)) await unmount(instance);
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** An app that holds a fresh entitled stamp, with the real background pull and router in place. */
async function entitledApp(platform: string) {
  const f = await installSafari({
    saved: "atomic",
    platform,
    entitlement: { entitled: true, updatedAt: Date.now(), installId: "install-1" },
  });
  const background = new ChromeEntitlementAdapter(Date.now, { authority: true });
  const route = createEntitlementMessageRouter(background, "still", "safari-web-extension://still/");
  const runtime = chrome.runtime as unknown as { sendMessage: (m: Record<string, unknown>) => Promise<unknown> };
  const pageSend = runtime.sendMessage;
  runtime.sendMessage = (message) =>
    new Promise((resolve, reject) => {
      const handled = route(message, { id: "still", url: EXTENSION_PAGE } as chrome.runtime.MessageSender, resolve);
      if (!handled) pageSend(message).then(resolve, reject);
    });
  await createEntitlementPull({
    send: () => browser.runtime.sendNativeMessage("still", { kind: "getEntitlement" }),
    sink: background,
    generations: new BrowserInstallGenerationStore(),
  })();
  document.body.innerHTML = '<div id="app"></div>';
  return f;
}

function expectFreeAndLocked(f: Awaited<ReturnType<typeof entitledApp>>) {
  // The stamp really arrived through the getEntitlement path and is entitled.
  expect(f.nativeKinds()).toContain("getEntitlement");
  expect(f.store["still:entitlement"]).toMatchObject({ entitled: true });
  // The free controls are present and usable.
  const youtube = screen.getByRole("switch", { name: "Still on YouTube" });
  expect(youtube.getAttribute("aria-disabled")).toBeNull();
  expect(screen.getByRole("switch", { name: "Still on Instagram" }).getAttribute("aria-disabled")).toBeNull();
  // Every Pro row is the inert locked design, never unlocked, never a purchase route.
  const locks = [...document.querySelectorAll<HTMLElement>(".lock-pro")];
  expect(locks.length).toBeGreaterThan(0);
  for (const lock of locks) {
    expect(lock.getAttribute("aria-disabled")).toBe("true");
    expect(lock.textContent).toBe("Still Pro");
  }
  for (const word of ["$", "Purchase", "Restore", "Buy", "Get Still Pro", "Open the Still app"]) {
    expect(text()).not.toContain(word);
  }
  expect(screen.queryByRole("dialog")).toBeNull();
}

async function tapEveryLockAndSettle(f: Awaited<ReturnType<typeof entitledApp>>) {
  const before = f.messages.length;
  const nativeBefore = f.native.length;
  for (const lock of document.querySelectorAll<HTMLElement>(".lock-pro")) await fireEvent.click(lock);
  for (let i = 0; i < 3; i++) await flush();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.messages.length).toBe(before);
  expect(f.native.length).toBe(nativeBefore);
  expect(f.native.filter((m) => UNPROMPTED_WRITES.includes(m.kind as string))).toEqual([]);
}

describe("Safari V3 with an entitled stamp while paid is off", () => {
  it.each(["ios", "mac"])("%s popup: free controls stay free, Pro rows stay locked, nothing is offered", async (platform) => {
    const f = await entitledApp(platform);
    expect(await startSafariV3Popup({ env: ENV, load: () => import("../v3-mount.js") })).toBe("v3");
    await screen.findByRole("switch", { name: "Still on Instagram" });
    if (platform === "mac") await fireEvent.click(screen.getByRole("button", { name: "YouTube Blocker" }));
    await waitFor(() => expect(document.querySelectorAll(".lock-pro").length).toBeGreaterThan(0));
    expectFreeAndLocked(f);
    await tapEveryLockAndSettle(f);
  });

  it("settings page: free controls stay free, Pro rows stay locked, nothing is offered", async () => {
    const f = await entitledApp("mac");
    expect(await startSafariV3Options({ env: ENV, load: () => import("../../options/v3-mount.js") })).toBe("v3");
    await screen.findByRole("switch", { name: "Still on Instagram" });
    await waitFor(() => expect(document.querySelectorAll(".lock-pro").length).toBeGreaterThan(0));
    expectFreeAndLocked(f);
    await tapEveryLockAndSettle(f);
  });
});
