import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick, type Component } from "svelte";
import { resolve } from "node:path";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { SettingsCache } from "../../storage/cache.js";
import { NativeBridge } from "../../native/bridge.js";
import { UiController } from "../controller.svelte.js";
import { STRINGS } from "../strings.js";
import { createAppleSession } from "../../sync/apple-session.js";
import { makeBridge } from "../../sync/__tests__/support/apple-session-harness.js";
import { createAppleSettingsAuthority } from "./apple-settings-host.js";
import { ACCOUNT, canonicalServer, client, settle } from "../../sync/__tests__/support/live-sync-harness.js";

vi.mock("@still/shared-types", async original => ({
  ...(await original<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

const HOST_PATH = resolve(import.meta.dirname, "../../../../app-webview/src/AppleSettingsHost.svelte");
const stops: (() => void)[] = [];
afterEach(() => { cleanup(); stops.splice(0).forEach(stop => stop()); });

async function compose() {
  const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
  const writer = new AtomicSettingsWriter(storage);
  await writer.initialize("never-linked");
  const cache = new SettingsCache({
    get: storage.get.bind(storage), set: storage.set.bind(storage),
    subscribe: storage.subscribe.bind(storage), commitIntent: writer.commit.bind(writer),
  });
  await cache.hydrate();
  const native = new NativeBridge({ webkit: { messageHandlers: { still: { postMessage: async () => null } } } });
  const authority = createAppleSettingsAuthority(cache, {
    native, initializer: { initializeAtomic: () => writer.initialize("unknown") }, hydration: cache.whenHydrated(),
  });
  stops.push(() => authority.stop());
  const requestCode = vi.fn(async () => ({ kind: "sent" as const }));
  const controller = new UiController({ cache, host: { canPurchase: true }, auth: {
    requestCode,
    verifyCode: async (email, code) => {
      if (code === "000000") return { kind: "invalid-code" };
      await session.onCodeVerified("synthetic-account", email);
      return { kind: "verified", userId: "synthetic-account", email };
    },
    signOut: () => session.signOutEverywhere(),
  } });
  stops.push(() => controller.dispose());
  const bridge = makeBridge();
  const sync = {
    onSignedIn: vi.fn(async (userId: string) => {
      session.onSyncState({ userId, entitled: false, syncing: false, cloudReachable: true, confirmed: true });
    }),
    signOut: vi.fn(async () => {
      session.onSyncState({ userId: null, entitled: false, syncing: false, cloudReachable: true, confirmed: true });
    }),
    deleteAccount: vi.fn(async () => {}),
  };
  const session = createAppleSession({ controller, sync, bridge, exchangeAppleCredential: async () => ({ error: "Unused" }) });
  const signOut = vi.spyOn(controller, "signOut");
  const { default: Host } = (await import(/* @vite-ignore */ HOST_PATH)) as { default: Component<Record<string, unknown>> };
  render(Host, { props: { controller, authority, observeSetup: async () => null, help: {} } });
  await screen.findByRole("button", { name: "Sign in" });
  return { controller, storage, bridge, requestCode, signOut };
}

async function enterCode(wrongFirst = false) {
  await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  const email = await screen.findByRole("textbox", { name: STRINGS.auth.emailLabel });
  await fireEvent.input(email, { target: { value: "reader@example.test" } });
  await fireEvent.click(screen.getByRole("button", { name: STRINGS.codeAuth.send }));
  const code = await screen.findByRole("textbox", { name: STRINGS.codeAuth.codeLabel });
  if (wrongFirst) {
    await fireEvent.input(code, { target: { value: "000000" } });
    await fireEvent.click(screen.getByRole("button", { name: STRINGS.codeAuth.verify }));
    await screen.findByText(STRINGS.codeAuth.wrongCode);
  }
  await fireEvent.input(code, { target: { value: "123456" } });
  await fireEvent.click(screen.getByRole("button", { name: STRINGS.codeAuth.verify }));
  await screen.findByRole("button", { name: "Sign out" });
}

describe("Apple settings host sign-in lifetime", () => {
  it("keeps actual cloud acquisition alive after delayed native cleanup fails across repeated mounted sign-ins", async () => {
    vi.useFakeTimers();
    const server = canonicalServer();
    const phone = await client(server), peer = await client(server);
    const native = new NativeBridge({ webkit: { messageHandlers: { still: { postMessage: async () => null } } } });
    const authority = createAppleSettingsAuthority(phone.cache, {
      native, initializer: { initializeAtomic: () => phone.writer.initialize("unknown") }, hydration: phone.cache.whenHydrated(),
    });
    const bridge = makeBridge();
    const controller = new UiController({ cache: phone.cache, host: { canPurchase: true }, auth: {
      requestCode: async () => ({ kind: "sent" }),
      verifyCode: async (email, code) => {
        if (code === "000000") return { kind: "invalid-code" };
        await session.onCodeVerified(ACCOUNT, email);
        return { kind: "verified", userId: ACCOUNT, email };
      },
      signOut: () => session.signOutEverywhere(),
    } });
    const session = createAppleSession({ controller, sync: phone.service, bridge,
      exchangeAppleCredential: async () => ({ error: "Unused" }) });
    phone.observeState(state => session.onSyncState(state));
    const { default: Host } = (await import(/* @vite-ignore */ HOST_PATH)) as { default: Component<Record<string, unknown>> };
    render(Host, { props: { controller, authority, observeSetup: async () => null, help: {} } });
    try {
      await session.onCodeVerified(ACCOUNT, "reader@example.test"); await tick();
      for (let cycle = 0; cycle < 2; cycle++) {
        let fail!: (error: Error) => void;
        const cleanupHeld = new Promise<void>((_resolve, reject) => { fail = reject; });
        vi.mocked(bridge.signOut).mockReturnValueOnce(cleanupHeld);
        const signingOut = controller.signOut(); await settle(); await tick();
        await enterCode(true);
        fail(new Error("native cleanup failed late")); await signingOut; await tick();
        expect(controller.userId).toBe(ACCOUNT);
        const wanted = cycle === 1;
        await peer.cache.setService("youtube", wanted); await settle();
        await vi.advanceTimersByTimeAsync(5_000); await settle(); await tick();
        expect(phone.cache.current().services.youtube).toBe(wanted);
        expect(screen.getByRole("switch", { name: /YouTube/ })).toHaveAttribute("aria-checked", String(wanted));
        expect(controller.userId).toBe(ACCOUNT);
        expect(phone.channel).not.toHaveBeenCalled();
      }
    } finally {
      cleanup(); authority.stop(); controller.dispose();
      await phone.close(); await peer.close(); vi.useRealTimers();
    }
  });

  it("supports repeated code sign-in after sign-out without remounting, including wrong-code retry", async () => {
    const f = await compose();
    const saved = await f.storage.get();
    await enterCode();
    for (let cycle = 0; cycle < 2; cycle++) {
      await fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      await f.signOut.mock.results.at(-1)!.value;
      await tick();
      expect(f.controller.userId).toBeNull();
      await enterCode(true);
      await waitFor(() => expect(f.controller.userId).toBe("synthetic-account"));
    }
    expect(f.requestCode).toHaveBeenCalledTimes(3);
    expect(f.bridge.purchaseStillPro).not.toHaveBeenCalled();
    expect(await f.storage.get()).toEqual(saved);
  });
});
