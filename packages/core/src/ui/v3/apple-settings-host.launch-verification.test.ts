// ISS-0137: the app verifies this device's Apple purchase at launch, in the background, before the
// settings screen exists. The right it installs changes native's record, but the screen reads the
// settings authority's cache, which otherwise learns of it at its next minute refresh (or after a
// relaunch). The authority must read again as soon as that verification settles.
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  FEATURE_REGISTRY,
  type BenefitAccessSnapshot,
} from "@still/shared-types";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { WKWebViewStorageAdapter } from "../../storage/wkwebview-adapter.js";
import {
  ACCESS_BENEFITS,
  initialAccessSnapshot,
} from "../../entitlement/access-policy.js";
import {
  appleSettingsCacheOptions,
  createAppleSettingsAuthority,
} from "./apple-settings-host.js";

const PRO = FEATURE_REGISTRY.filter((row) => row.tier === "pro").map((row) => row.id);

function snapshot(
  state: "purchased" | "verification_required",
  generation = 0,
): BenefitAccessSnapshot {
  const value = initialAccessSnapshot({
    paidMode: true,
    supported: new Set(ACCESS_BENEFITS),
  });
  return {
    ...value,
    generation,
    states: {
      ...value.states,
      ...Object.fromEntries(PRO.map((id) => [id, state])),
    },
  };
}

async function compose() {
  const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
  const writer = new AtomicSettingsWriter(storage);
  const adapter = new WKWebViewStorageAdapter({
    webkit: {
      messageHandlers: {
        still: {
          postMessage: async (message) => {
            const m = message as { kind: string };
            if (m.kind === "get") return (await storage.get()) ?? "";
            if (m.kind === "settingsAtomic") return writer.initialize("unknown");
            return null;
          },
        },
      },
    },
  });
  const cache = new SettingsCache(adapter, appleSettingsCacheOptions("atomic-local"));
  cache.watch();
  await cache.hydrate();
  return { cache, adapter };
}

const proStates = (authority: ReturnType<typeof createAppleSettingsAuthority>) =>
  new Set(PRO.map((id) => authority.entitlement.currentAccessSnapshot().states[id]));

describe("the launch's local purchase verification reaches the settings screen (ISS-0137)", () => {
  it("reads access again once the verification installs a right, without waiting for the minute refresh", async () => {
    const { cache, adapter } = await compose();
    let rights = snapshot("verification_required");
    const observeBenefits = vi.fn(async () => rights);
    let installed!: () => void;
    const verification = new Promise<void>((resolve) => {
      installed = resolve;
    });
    const authority = createAppleSettingsAuthority(cache, {
      native: { observeBenefits },
      initializer: adapter,
      hydration: cache.whenHydrated(),
      pendingLocalVerification: verification,
    });
    await authority.entitlement.refreshAccess();
    expect(proStates(authority)).toEqual(new Set(["verification_required"]));
    expect(observeBenefits).toHaveBeenCalledOnce();
    // Native commits the right (the launch verification's install), then the verification settles.
    rights = snapshot("purchased", 1);
    installed();
    await vi.waitFor(() => expect(proStates(authority)).toEqual(new Set(["purchased"])));
    expect(observeBenefits.mock.calls.length).toBeGreaterThanOrEqual(2);
    authority.stop();
  });

  it("finishes a read already in flight before reading the committed record", async () => {
    // The install can land while the authority's first read is still waiting on native; that read
    // predates the commit, so one more read must follow it.
    const { cache, adapter } = await compose();
    let rights = snapshot("verification_required");
    let answerFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      answerFirst = resolve;
    });
    const observeBenefits = vi.fn(async () => {
      if (observeBenefits.mock.calls.length === 1) await firstRead;
      return rights;
    });
    let installed!: () => void;
    const verification = new Promise<void>((resolve) => {
      installed = resolve;
    });
    const authority = createAppleSettingsAuthority(cache, {
      native: { observeBenefits },
      initializer: adapter,
      hydration: cache.whenHydrated(),
      pendingLocalVerification: verification,
    });
    rights = snapshot("purchased", 1);
    installed();
    await Promise.resolve();
    answerFirst();
    await vi.waitFor(() => expect(proStates(authority)).toEqual(new Set(["purchased"])));
    expect(observeBenefits).toHaveBeenCalledTimes(2);
    authority.stop();
  });

  it("a verification that installed nothing triggers no extra read", async () => {
    const { cache, adapter } = await compose();
    const observeBenefits = vi.fn(async () => snapshot("verification_required"));
    const authority = createAppleSettingsAuthority(cache, {
      native: { observeBenefits },
      initializer: adapter,
      hydration: cache.whenHydrated(),
      pendingLocalVerification: Promise.reject(new Error("Apple purchase requires verification")),
    });
    await authority.entitlement.refreshAccess();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observeBenefits).toHaveBeenCalledOnce();
    authority.stop();
  });

  it("exposes the launch verification, settled either way, for the Pro host to wait on before verifying itself", async () => {
    // ISS-0137: the screen verifies a held right itself; it waits for the launch's attempt first
    // so a launch never asks the server twice for the same right. A rejected attempt and no
    // attempt at all both settle at once.
    const { cache, adapter } = await compose();
    const observeBenefits = vi.fn(async () => snapshot("verification_required"));
    let installed!: () => void;
    const verification = new Promise<void>((resolve) => {
      installed = resolve;
    });
    const waiting = createAppleSettingsAuthority(cache, {
      native: { observeBenefits },
      initializer: adapter,
      hydration: cache.whenHydrated(),
      pendingLocalVerification: verification,
    });
    let settled = false;
    void waiting.localVerification.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    installed();
    await waiting.localVerification;
    waiting.stop();
    const rejected = createAppleSettingsAuthority(cache, {
      native: { observeBenefits },
      initializer: adapter,
      hydration: cache.whenHydrated(),
      pendingLocalVerification: Promise.reject(new Error("offline at launch")),
    });
    await expect(rejected.localVerification).resolves.toBeUndefined();
    rejected.stop();
    const none = createAppleSettingsAuthority(cache, {
      native: { observeBenefits },
      initializer: adapter,
      hydration: cache.whenHydrated(),
    });
    await expect(none.localVerification).resolves.toBeUndefined();
    none.stop();
  });

  it("a verification that settles after the screen is gone reads nothing", async () => {
    const { cache, adapter } = await compose();
    const observeBenefits = vi.fn(async () => snapshot("verification_required"));
    let installed!: () => void;
    const verification = new Promise<void>((resolve) => {
      installed = resolve;
    });
    const authority = createAppleSettingsAuthority(cache, {
      native: { observeBenefits },
      initializer: adapter,
      hydration: cache.whenHydrated(),
      pendingLocalVerification: verification,
    });
    await authority.entitlement.refreshAccess();
    authority.stop();
    installed();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observeBenefits).toHaveBeenCalledOnce();
  });
});
