import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { createTikTokBlockedHost } from "@still/core/ui/v3/tiktok-blocked-host";
import BlockedPage from "../BlockedPage.svelte";

afterEach(cleanup);
const MANUAL = "To change this, open the Still app and turn off TikTok website.";
async function mount(os: string | undefined, readPlatform = async () => os) {
  const native = { getPlatformInfo: vi.fn(readPlatform), openOptionsPage: vi.fn(async () => {}) };
  const send = vi.fn(async (_message: { kind: string }) => ({ status: "blocked", tab: 7 }));
  const host = createTikTokBlockedHost({ send, openSettings: () => native.openOptionsPage(), navigate: () => {}, request: "surface-request", document: "surface-document" });
  await host.start();
  const view = render(BlockedPage, { host, readPlatform: () => native.getPlatformInfo() });
  return { native, send, host, view };
}

describe("actual Safari blocked wrapper selects the settings destination from the native platform port", () => {
  it("Mac keeps the desktop settings action and calls the provided options port", async () => {
    const { native, send, host } = await mount("mac");
    const action = await screen.findByRole("button", { name: "Change this in Still settings" });
    expect(screen.queryByText(MANUAL)).toBeNull();
    await fireEvent.click(action);
    expect(native.getPlatformInfo).toHaveBeenCalledOnce();
    expect(native.openOptionsPage).toHaveBeenCalledOnce();
    expect(send.mock.calls.map(([message]) => message.kind)).toEqual(["still:tiktok-screen"]);
    host.stop();
  });
  it.each(["iPhone", "iPad"])("%s retains manual guidance without a settings action", async () => {
    const { native, host } = await mount("ios");
    expect(await screen.findByText(MANUAL)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change this in Still settings" })).toBeNull();
    expect(native.openOptionsPage).not.toHaveBeenCalled(); host.stop();
  });
  it.each([undefined, "unknown", "macos"])("unrecognized native OS %s retains conservative manual guidance", async (os) => {
    const { native, host } = await mount(os);
    expect(await screen.findByText(MANUAL)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change this in Still settings" })).toBeNull();
    expect(native.openOptionsPage).not.toHaveBeenCalled(); host.stop();
  });
  it("a failed native platform read retains guidance and never dispatches options", async () => {
    const { native, host } = await mount(undefined, async () => { throw new Error("Native platform unavailable"); });
    expect(await screen.findByText(MANUAL)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change this in Still settings" })).toBeNull();
    expect(native.openOptionsPage).not.toHaveBeenCalled(); host.stop();
  });
  it("a synchronously throwing native port retains manual guidance", async () => {
    const { native, host } = await mount(undefined, () => { throw new Error("Native platform method absent"); });
    expect(await screen.findByText(MANUAL)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change this in Still settings" })).toBeNull();
    expect(native.openOptionsPage).not.toHaveBeenCalled(); host.stop();
  });
  it("a late Mac read shows no settings action until the native result arrives", async () => {
    let resolve!: (os: string) => void;
    const { native, host } = await mount(undefined, () => new Promise(resolveRead => { resolve = resolveRead; }));
    expect(await screen.findByText(MANUAL)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change this in Still settings" })).toBeNull();
    resolve("mac"); expect(await screen.findByRole("button", { name: "Change this in Still settings" })).toBeTruthy();
    expect(native.openOptionsPage).not.toHaveBeenCalled(); host.stop();
  });
  it.each(["pagehide", "unmount"] as const)("%s retires a pending Mac presentation response", async (event) => {
    let resolve!: (os: string) => void;
    const { native, host, view } = await mount(undefined, () => new Promise(resolveRead => { resolve = resolveRead; }));
    await screen.findByText(MANUAL);
    if (event === "pagehide") { host.stop(); window.dispatchEvent(new PageTransitionEvent("pagehide")); } else view.unmount();
    resolve("mac"); for (let i=0;i<5;i++) await Promise.resolve(); await tick();
    expect(screen.queryByRole("button", { name: "Change this in Still settings" })).toBeNull();
    expect(native.openOptionsPage).not.toHaveBeenCalled(); host.stop();
  });
});
