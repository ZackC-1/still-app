import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import {
  DEFAULT_SETTINGS,
  type AccessState,
  type BenefitAccessSnapshot,
  type FeatureId,
  type ServiceId,
} from "@still/shared-types";
import {
  InMemoryStorageAdapter,
  type StorageAdapter,
} from "../../storage/adapter.js";
import {
  AtomicSettingsWriter,
  requireModernSettings,
  SettingsStorageRecovery,
} from "../../storage/atomic-settings.js";
import { SettingsCache } from "../../storage/cache.js";
import { EntitlementCache } from "../../entitlement/cache.js";
import { ChromeEntitlementAdapter } from "../../entitlement/chrome-adapter.js";
import { verifyAccessProof, type AccessTrust } from "../../entitlement/access-proof.js";
import vectors from "../../../../../tests/access-proof/vectors.json";
import {
  ACCESS_BENEFITS,
  initialAccessSnapshot,
} from "../../entitlement/access-policy.js";
import DesktopPopup from "./DesktopPopup.svelte";
import type { DesktopPopupProps } from "./presentation.js";
import {
  createDesktopPopupBinding,
  type DesktopPopupCommandOutcome,
} from "./desktop-popup-binding.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("reviewed authority publication and stop admission", () => {
  it("keeps later subscribers on nested authority recovery instead of the superseded hold", async () => {
    const f = await fixture();
    const durable = (await f.storage.get())!;
    f.binding.subscribe(state => {
      if (state.reason === "ownership-hold") f.storage.emitExternal(durable);
    });
    const later: (string | null)[] = [];
    f.binding.subscribe(state => later.push(state.reason));
    const writerCalls = vi.fn(f.writer.commit.bind(f.writer));
    f.port(writerCalls);
    f.writes.mockClear();
    f.storage.emitExternal({
      ...durable,
      atomic: { ...durable.atomic!, paused: "ownership-hold" },
    });
    expect(f.binding.current().commandAvailability).toBe("ready");
    expect(later).toEqual([null, null]);
    // An identical healthy receipt is deduplicated; it cannot repair stale delivery.
    f.storage.emitExternal(durable);
    expect(later).toEqual([null, null]);
    expect(await f.storage.get()).toEqual(durable);
    expect(writerCalls).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("keeps later subscribers on nested signed access expiry with saved On and no new writer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const f = await fixture();
    await f.settings.setFeature("youtube.comments", true);
    // Public synthetic signed vectors exercise the maintained verifier and authority;
    // this sandbox trust never grants a production capability.
    const trust: AccessTrust = {
      environment: "sandbox",
      keys: [{ kid: "synthetic-access", purpose: "access", environment: "sandbox", publicKeyHex: vectors.publicKeyHex }],
    };
    const store: Record<string, unknown> = {};
    vi.stubGlobal("chrome", { storage: { local: {
      get: async (key: string) => ({ [key]: structuredClone(store[key]) }),
      set: async (items: Record<string, unknown>) => { Object.assign(store, structuredClone(items)); },
    } } });
    const authority = new ChromeEntitlementAdapter(Date.now, {
      authority: true,
      trust,
      context: () => ({
        paidMode: true,
        supported: new Set(ACCESS_BENEFITS),
        session: { userId: vectors.account, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        localRights: new Set<string>(),
        evidenceStatus: "unknown",
      }),
    });
    await authority.observeBenefits();
    const scope = await authority.observeAccess();
    const proof = await verifyAccessProof(vectors.vectors.find(v => v.name === "paid-account")!.envelope, trust);
    if (proof.status !== "verified") throw new Error("Synthetic signed access proof rejected");
    await authority.mutateAccess({ kind: "install", proof: proof.proof, generation: scope.generation, issuerNow: vectors.verifiedAt, wall: 1000, localRights: new Set() });
    const access = new EntitlementCache(authority, { access: { paidMode: true, supported: new Set(ACCESS_BENEFITS) } });
    const grant = await access.refreshAccess();
    expect(grant.states["youtube.comments"]).toBe("purchased");
    expect(grant.refreshAfterMs).toBeGreaterThan(0);
    // No timer/watch: model a suspended page reaching expiry inside a synchronous read.
    const binding = createDesktopPopupBinding(f.settings, access);
    cleanups.push(binding.stop);
    binding.subscribe(state => {
      if (!state.settings!.services.instagram && state.access.states["youtube.comments"] === "purchased") {
        vi.setSystemTime(1000 + grant.refreshAfterMs!);
        access.currentAccessSnapshot();
      }
    });
    const later: AccessState[] = [];
    binding.subscribe(state => later.push(state.access.states["youtube.comments"]));
    await f.settings.setService("instagram", false);
    expect(binding.current().access.states["youtube.comments"]).toBe("verification_required");
    expect(later).toEqual(["purchased", "verification_required"]);
    const saved = await f.storage.get();
    const writerCalls = vi.fn(f.writer.commit.bind(f.writer));
    f.port(writerCalls);
    f.writes.mockClear();
    expect(binding.current().commandAvailability).toBe("ready");
    expect(binding.current().settings!.sites["youtube.comments"]).toBe(true);
    expect(await binding.setFeature("youtube.comments", false)).toEqual({ status: "rejected", reason: "inactive-or-unavailable" });
    expect(await f.storage.get()).toEqual(saved);
    expect(writerCalls).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("publishes same-choice same-sequence recovery without inventing a saved edit", async () => {
    const f = await fixture();
    const durable = (await f.storage.get())!;
    const seen: string[] = [];
    f.binding.subscribe(state => seen.push(state.commandAvailability));
    const legacy = vi.fn();
    cleanups.push(f.settings.subscribe(legacy));
    f.port(async () => { throw new SettingsStorageRecovery("native-authority-unavailable"); });
    expect((await f.binding.setGlobalOn(false)).status).toBe("unavailable");
    expect(seen).toEqual(["ready", "unavailable"]);
    await f.storage.set(durable);
    expect(f.binding.current().commandAvailability).toBe("ready");
    expect(seen).toEqual(["ready", "unavailable", "ready"]);
    expect(legacy).not.toHaveBeenCalled();
    expect(await f.storage.get()).toEqual(durable);
    expect(f.settings.currentRecord().atomic!.sequence).toBe(durable.atomic!.sequence);
  });

  it.each(["paused", "ownership"] as const)("publishes metadata-only %s holds without changing choices", async kind => {
    const f = await fixture();
    const durable = (await f.storage.get())!;
    const seen: (string | null)[] = [];
    f.binding.subscribe(state => seen.push(state.reason));
    const legacy = vi.fn();
    cleanups.push(f.settings.subscribe(legacy));
    await f.storage.set({ ...durable, atomic: { ...durable.atomic!,
      paused: kind === "paused" ? "ownership-hold" : null,
      ownership: kind === "ownership" ? "unknown" : "never-linked",
    } });
    const reason = kind === "paused" ? "ownership-hold" : "ownership-unconfirmed";
    expect(seen).toEqual([null, reason]);
    expect(f.binding.current().settings).toEqual(requireModernSettings(durable));
    f.writes.mockClear();
    expect((await f.binding.setGlobalOn(false)).status).toBe("unavailable");
    expect(f.writes).not.toHaveBeenCalled();
    await f.storage.set(durable);
    expect(seen).toEqual([null, reason, null]);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("publishes a sibling-origin failure and recovery while a stopped instance stays silent", async () => {
    const f = await fixture();
    const sibling = createDesktopPopupBinding(f.settings, f.access);
    cleanups.push(sibling.stop);
    const first: string[] = [], second: string[] = [];
    f.binding.subscribe(state => first.push(state.commandAvailability));
    sibling.subscribe(state => second.push(state.commandAvailability));
    const durable = (await f.storage.get())!;
    f.port(async () => { throw new SettingsStorageRecovery("native-authority-unavailable"); });
    await f.binding.setGlobalOn(false);
    expect(second).toEqual(["ready", "unavailable"]);
    f.binding.stop();
    const frozen = f.binding.current();
    await f.storage.set(durable);
    expect(second).toEqual(["ready", "unavailable", "ready"]);
    expect(first).toEqual(["ready", "unavailable"]);
    expect(f.binding.current()).toEqual(frozen);
    expect(await f.storage.get()).toEqual(durable);
  });

  it.each(["global", "service", "feature"] as const)("keeps stopped %s admission private despite a mutated returned view", async kind => {
    const f = await fixture();
    const writerCalls = vi.fn(f.writer.commit.bind(f.writer));
    f.port(writerCalls);
    const durable = await f.storage.get();
    f.binding.stop();
    const exposed = f.binding.current();
    Reflect.set(exposed, "commandAvailability", "ready");
    Reflect.set(exposed, "reason", null);
    const command = kind === "global" ? f.binding.setGlobalOn(false)
      : kind === "service" ? f.binding.setService("youtube", false)
      : f.binding.setFeature("youtube.shorts", false);
    expect(await command).toEqual({ status: "unavailable", reason: "stopped" });
    expect(writerCalls).not.toHaveBeenCalled();
    expect(await f.storage.get()).toEqual(durable);
    expect(f.binding.current().commandAvailability).toBe("unavailable");
    expect(f.binding.current().reason).toBe("stopped");
  });

  it("allows reentrant stop to fence later listeners without cancelling the admitted writer", async () => {
    const f = await fixture();
    let stopping = false;
    f.binding.subscribe(state => {
      if (!stopping) return;
      f.binding.stop();
      Reflect.set(state, "commandAvailability", "ready");
      Reflect.set(state, "reason", null);
    });
    const later = vi.fn();
    f.binding.subscribe(later);
    later.mockClear();
    stopping = true;
    expect(await f.binding.setGlobalOn(false)).toEqual({ status: "committed" });
    expect(later).not.toHaveBeenCalled();
    expect((await f.storage.get())!.settings.globalOn).toBe(false);
    f.writes.mockClear();
    expect(await f.binding.setGlobalOn(true)).toEqual({ status: "unavailable", reason: "stopped" });
    expect(f.writes).not.toHaveBeenCalled();
  });
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function fixture(syntheticOptionalAccess = false) {
  const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
  let id = 0;
  const writer = new AtomicSettingsWriter(
    storage,
    () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  );
  const record = await writer.initialize("never-linked");
  const augmented = { ...record.settings, futureHint: { keep: "saved" } };
  await storage.set({ ...record, settings: augmented });
  let port: NonNullable<StorageAdapter["commitIntent"]> =
    writer.commit.bind(writer);
  const settings = new SettingsCache(
    {
      get: storage.get.bind(storage),
      set: storage.set.bind(storage),
      subscribe: storage.subscribe.bind(storage),
      commitIntent: (intent) => port(intent),
    },
    { now: () => 100 },
  );
  await settings.hydrate();
  const initial = syntheticOptionalAccess
    ? initialAccessSnapshot({
        paidMode: true,
        supported: new Set(ACCESS_BENEFITS),
      })
    : initialAccessSnapshot();
  // Labelled synthetic projection exercises handler guards, never a production capability grant.
  let observation: BenefitAccessSnapshot = syntheticOptionalAccess
    ? {
        ...initial,
        states: { ...initial.states, "youtube.comments": "purchased" },
      }
    : { ...initial, refreshAfterMs: 60_000 };
  const access = new EntitlementCache(
    {
      get: async () => false,
      set: async () => {},
      subscribe: () => () => {},
      observeBenefits: async () => observation,
    },
    { access: { paidMode: true, supported: new Set(ACCESS_BENEFITS) } },
  );
  await access.refreshAccess();
  // Host owns these watchers; the binding may remove only its own subscriptions.
  cleanups.push(settings.watch(), access.watch());
  const binding = createDesktopPopupBinding(settings, access);
  cleanups.push(binding.stop);
  const writes = vi.spyOn(storage, "set");
  return {
    storage,
    writer,
    settings,
    access,
    binding,
    writes,
    port: (next: NonNullable<StorageAdapter["commitIntent"]>) => {
      port = next;
    },
    accessState: async (state: AccessState) => {
      observation = {
        ...observation,
        generation: observation.generation + 1,
        states: { ...observation.states, "youtube.comments": state },
      };
      await access.refreshAccess();
    },
  };
}

describe("existing committed-cache seams (pre-implementation characterization)", () => {
  it("does not infer an atomic writer from an atomic record", async () => {
    const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
    await new AtomicSettingsWriter(storage).initialize("never-linked");
    const cache = new SettingsCache({
      get: storage.get.bind(storage),
      subscribe: storage.subscribe.bind(storage),
      set: async () => {
        throw new Error("lost legacy write");
      },
    });
    await cache.hydrate();
    const saved = await storage.get();
    expect(cache.currentRecord().atomic?.paused).toBeNull();
    expect(requireModernSettings(cache.currentRecord()).globalOn).toBe(true);
    await expect(cache.setGlobalOn(false)).rejects.toThrow("lost legacy write");
    expect(cache.current().globalOn).toBe(false);
    expect(await storage.get()).toEqual(saved);
  });

  it("does not expose a refused atomic intent marker through the existing setter", async () => {
    const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
    await new AtomicSettingsWriter(storage).initialize("never-linked");
    const cache = new SettingsCache({
      get: storage.get.bind(storage),
      subscribe: storage.subscribe.bind(storage),
      set: storage.set.bind(storage),
      commitIntent: async () => ({
        ...(await storage.get())!,
        intentCommitted: false,
      }),
    });
    await cache.hydrate();
    const saved = await storage.get();
    const returned = await cache.setGlobalOn(false);
    expect(returned.globalOn).toBe(true);
    expect("intentCommitted" in returned).toBe(false);
    expect(await storage.get()).toEqual(saved);
  });
});

describe("D01 committed binding", () => {
  it("commits master, service, TikTok and saved Shorts Off to On through the real writer", async () => {
    const { binding, storage, settings } = await fixture();
    await settings.setFeature("youtube.shorts", false);
    for (const [path, value, run] of [
      ["globalOn", false, () => binding.setGlobalOn(false)],
      ["globalOn", true, () => binding.setGlobalOn(true)],
      ["services.youtube", false, () => binding.setService("youtube", false)],
      ["services.youtube", true, () => binding.setService("youtube", true)],
      ["services.tiktok", false, () => binding.setService("tiktok", false)],
      ["services.tiktok", true, () => binding.setService("tiktok", true)],
      [
        "sites.youtube.shorts",
        true,
        () => binding.setFeature("youtube.shorts", true),
      ],
    ] as const) {
      const before = (await storage.get())!;
      const prior = requireModernSettings(before);
      expect(await run()).toEqual({ status: "committed" });
      const committed = (await storage.get())!;
      const saved = requireModernSettings(committed);
      let expected = {
        ...prior,
        updatedAt: 100,
        clocks: {
          ...prior.clocks,
          [path]: {
            ...prior.clocks[path]!,
            localStep: prior.clocks[path]!.localStep + 1,
          },
        },
      };
      if (path === "globalOn") expected = { ...expected, globalOn: value };
      else if (path.startsWith("services."))
        expected = {
          ...expected,
          services: { ...expected.services, [path.slice(9)]: value },
        };
      else
        expected = {
          ...expected,
          sites: { ...expected.sites, [path.slice(6)]: value },
        };
      expect(saved).toEqual(expected);
      expect(committed.atomic!.sequence).toBe(before.atomic!.sequence + 1);
      expect(binding.current().settings).toEqual(saved);
    }
  });

  it("does not expose a mutable alias of committed settings", async () => {
    const { binding, settings, storage } = await fixture();
    const before = await storage.get();
    const view = binding.current().settings!;
    // The detached projection may be changed by a consumer; it cannot mutate authority.
    Reflect.set(view.sites, "youtube.shorts", false);
    expect(
      requireModernSettings(settings.currentRecord()).sites["youtube.shorts"],
    ).toBe(true);
    expect(await storage.get()).toEqual(before);
  });

  it.each(["purchased", "protected"] as const)(
    "enables a saved Off with labelled synthetic %s access",
    async (state) => {
      const f = await fixture(true);
      expect(f.binding.current().settings!.sites["youtube.comments"]).toBe(
        false,
      );
      await f.accessState(state);
      const before = (await f.storage.get())!;
      expect(await f.binding.setFeature("youtube.comments", true)).toEqual({
        status: "committed",
      });
      expect(
        requireModernSettings((await f.storage.get())!).sites[
          "youtube.comments"
        ],
      ).toBe(true);
      expect((await f.storage.get())!.atomic!.sequence).toBe(
        before.atomic!.sequence + 1,
      );
    },
  );

  it.each([
    "checking",
    "verification_required",
    "locked",
    "unsupported",
  ] as const)(
    "readmits against current %s access and retains saved On",
    async (state) => {
      const { settings, binding, accessState, storage, writes } =
        await fixture(true);
      await settings.setFeature("youtube.comments", true);
      const rendered = binding.current();
      expect(rendered.access.states["youtube.comments"]).toBe("purchased");
      const before = await storage.get();
      writes.mockClear();
      await accessState(state);
      expect(binding.current().settings!.sites["youtube.comments"]).toBe(true);
      expect(await binding.setFeature("youtube.comments", false)).toEqual({
        status: "rejected",
        reason: "inactive-or-unavailable",
      });
      expect(await storage.get()).toEqual(before);
      expect(writes).not.toHaveBeenCalled();
    },
  );

  it.each(["global", "service"] as const)(
    "rejects stale UI commands after current %s changes",
    async (kind) => {
      const { binding, settings, storage, writes } = await fixture();
      expect(binding.current().settings!.globalOn).toBe(true);
      if (kind === "global") await settings.setGlobalOn(false);
      else await settings.setService("youtube", false);
      const before = await storage.get();
      writes.mockClear();
      expect((await binding.setFeature("youtube.shorts", false)).status).toBe(
        "rejected",
      );
      if (kind === "global")
        expect((await binding.setService("tiktok", false)).status).toBe(
          "rejected",
        );
      expect(await storage.get()).toEqual(before);
      expect(writes).not.toHaveBeenCalled();
    },
  );

  it.each([
    (b: ReturnType<typeof createDesktopPopupBinding>) =>
      b.setGlobalOn("yes" as unknown as boolean),
    (b: ReturnType<typeof createDesktopPopupBinding>) =>
      b.setService("unknown" as ServiceId, true),
    (b: ReturnType<typeof createDesktopPopupBinding>) =>
      b.setFeature("unknown" as FeatureId, true),
    (b: ReturnType<typeof createDesktopPopupBinding>) =>
      b.setFeature("youtube.shorts", 1 as unknown as boolean),
  ])("denies invalid command input without a write", async (command) => {
    const { binding, storage, writes } = await fixture();
    const before = await storage.get();
    expect(await command(binding)).toEqual({
      status: "rejected",
      reason: "invalid-input",
    });
    expect(await storage.get()).toEqual(before);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each(["paused", "unknown", "legacy", "future"] as const)(
    "keeps %s state explicit and denies unsafe commands",
    async (kind) => {
      const { binding, storage, writes } = await fixture();
      const record = (await storage.get())!;
      const savedSettings =
        kind === "legacy"
          ? DEFAULT_SETTINGS
          : kind === "future"
            ? { ...record.settings, schemaVersion: 3 }
            : record.settings;
      await storage.set({
        ...record,
        settings: savedSettings,
        atomic: {
          ...record.atomic!,
          sequence: record.atomic!.sequence + 1,
          paused: kind === "paused" ? "ordering-hold" : null,
          ownership: kind === "unknown" ? "unknown" : "never-linked",
        },
      });
      const before = await storage.get();
      writes.mockClear();
      const state = binding.current();
      expect(state.commandAvailability).toBe("unavailable");
      if (kind === "paused" || kind === "unknown")
        expect(state.settings!.globalOn).toBe(true);
      else expect(state.settings).toBeNull();
      expect((await binding.setGlobalOn(false)).status).toBe("unavailable");
      expect((await binding.setService("youtube", false)).status).toBe(
        "unavailable",
      );
      expect((await binding.setFeature("youtube.shorts", false)).status).toBe(
        "unavailable",
      );
      expect(await storage.get()).toEqual(before);
      expect(writes).not.toHaveBeenCalled();
    },
  );

  it("returns the request's non-commit even when an external write matches its desired value", async () => {
    const f = await fixture();
    const reached = gate(),
      held = gate();
    f.port(async () => {
      reached.open();
      await held.promise;
      return { ...(await f.storage.get())!, intentCommitted: false };
    });
    const pending = f.binding.setGlobalOn(false);
    await reached.promise;
    await f.writer.commit({ path: "globalOn", value: false, updatedAt: 101 });
    held.open();
    expect(await pending).toEqual({ status: "not-committed" });
    expect(f.binding.current().settings!.globalOn).toBe(false);
  });

  it("keeps a held request failure explicit without discarding a newer independently committed edit", async () => {
    const f = await fixture();
    const reached = gate(),
      held = gate();
    f.port(async () => {
      reached.open();
      await held.promise;
      throw new SettingsStorageRecovery("native-authority-unavailable");
    });
    const pending = f.binding.setFeature("youtube.shorts", false);
    await reached.promise;
    expect(f.binding.current().settings!.sites["youtube.shorts"]).toBe(true);
    await f.writer.commit({
      path: "services.instagram",
      value: false,
      updatedAt: 101,
    });
    held.open();
    expect(await pending).toEqual({
      status: "unavailable",
      reason: "native-authority-unavailable",
    });
    expect(f.binding.current().settings!.sites["youtube.shorts"]).toBe(true);
    expect(f.binding.current().settings!.services.instagram).toBe(false);
    // Existing cache authority-ticket semantics prevent this older failure poisoning a newer receipt.
    expect(f.binding.current().commandAvailability).toBe("ready");
  });

  it("retains saved choices and exposes recovery when a write fails without a newer authority receipt", async () => {
    const f = await fixture();
    const before = await f.storage.get();
    f.port(async () => {
      throw new SettingsStorageRecovery("native-authority-unavailable");
    });
    expect(await f.binding.setGlobalOn(false)).toEqual({
      status: "unavailable",
      reason: "native-authority-unavailable",
    });
    expect(f.binding.current().commandAvailability).toBe("unavailable");
    expect(f.binding.current().settings!.globalOn).toBe(true);
    expect(await f.storage.get()).toEqual(before);
    expect(f.writes).not.toHaveBeenCalled();
  });

  it("does not fabricate its own success after an applied write loses its acknowledgement", async () => {
    const f = await fixture();
    f.port(async (intent) => {
      await f.writer.commit(intent);
      throw new SettingsStorageRecovery("native-authority-unavailable");
    });
    expect(await f.binding.setGlobalOn(false)).toEqual({
      status: "unavailable",
      reason: "native-authority-unavailable",
    });
    // The host's independent storage notification is real committed display data, not an action receipt.
    expect((await f.storage.get())!.settings.globalOn).toBe(false);
    expect(f.binding.current().settings!.globalOn).toBe(false);
  });

  it("owns only its listener lifetime; stop denies new writes and fences an admitted completion", async () => {
    const f = await fixture();
    const settingsWatch = vi.spyOn(f.settings, "watch"),
      accessWatch = vi.spyOn(f.access, "watch");
    const other = createDesktopPopupBinding(f.settings, f.access);
    cleanups.push(other.stop);
    expect(settingsWatch).not.toHaveBeenCalled();
    expect(accessWatch).not.toHaveBeenCalled();
    const first = vi.fn(),
      second = vi.fn(),
      sibling = vi.fn();
    const unsubscribe = f.binding.subscribe(first);
    f.binding.subscribe(second);
    other.subscribe(sibling);
    first.mockClear();
    second.mockClear();
    sibling.mockClear();
    await f.binding.setGlobalOn(false);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    unsubscribe();
    first.mockClear();
    second.mockClear();
    sibling.mockClear();
    await f.binding.setGlobalOn(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(sibling).toHaveBeenCalledOnce();
    const reached = gate(),
      held = gate();
    f.port(async (intent) => {
      reached.open();
      await held.promise;
      return f.writer.commit(intent);
    });
    const pending = f.binding.setGlobalOn(false);
    await reached.promise;
    f.binding.stop();
    const stoppedView = f.binding.current();
    first.mockClear();
    second.mockClear();
    sibling.mockClear();
    f.writes.mockClear();
    const refused = f.binding.setGlobalOn(false);
    expect(f.writes).not.toHaveBeenCalled();
    held.open();
    expect(await refused).toEqual({ status: "unavailable", reason: "stopped" });
    expect(await pending).toEqual({ status: "committed" }); // Stop cannot cancel an admitted authority transaction.
    expect((await f.storage.get())!.settings.globalOn).toBe(false);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(sibling).toHaveBeenCalled();
    expect(f.binding.current()).toEqual(stoppedView);
    await f.writer.commit({
      path: "services.instagram",
      value: false,
      updatedAt: 102,
    });
    expect(other.current().settings!.services.instagram).toBe(false);
  });

  it("connects real D01 controls to committed state and handled outcomes without access-only writes", async () => {
    const f = await fixture(true);
    await f.settings.setFeature("youtube.comments", true);
    let pending: Promise<DesktopPopupCommandOutcome> = Promise.resolve({
      status: "not-committed",
    });
    const outcomes: DesktopPopupCommandOutcome[] = [];
    const handle = (operation: Promise<DesktopPopupCommandOutcome>) => {
      pending = operation.then((result) => {
        outcomes.push(result);
        return result;
      });
    };
    const state = f.binding.current();
    const props: DesktopPopupProps = {
      settings: state.settings!,
      access: state.access,
      browser: "Chrome",
      privacyUrl: "https://still.test/privacy",
      onSettings: () => {},
      onGlobalChange: (next) => handle(f.binding.setGlobalOn(next)),
      onServiceChange: (id, next) => handle(f.binding.setService(id, next)),
      onFeatureChange: (id, next) => handle(f.binding.setFeature(id, next)),
    };
    const view = render(DesktopPopup, { props });
    let rendering = Promise.resolve();
    const unsubscribe = f.binding.subscribe((next) => {
      if (next.settings)
        rendering = rendering.then(() =>
          view.rerender({
            ...props,
            settings: next.settings!,
            access: next.access,
          }),
        );
    });
    await rendering;
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    await fireEvent.click(screen.getByRole("switch", { name: "Shorts" }));
    await pending;
    await rendering;
    expect(screen.getByRole("switch", { name: "Shorts" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(
      requireModernSettings((await f.storage.get())!).sites["youtube.shorts"],
    ).toBe(false);
    await fireEvent.click(screen.getByRole("switch", { name: "Shorts" }));
    await pending;
    await rendering;
    expect(screen.getByRole("switch", { name: "Shorts" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const saved = await f.storage.get();
    f.writes.mockClear();
    await f.accessState("checking");
    await rendering;
    const comments = screen.getByRole("switch", { name: "Comments" });
    expect(comments).toHaveAttribute("aria-checked", "true");
    expect(comments).toHaveAttribute("aria-disabled", "true");
    expect(await f.storage.get()).toEqual(saved);
    expect(f.writes).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await pending;
    await rendering;
    expect(screen.getByRole("switch", { name: "Still" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(outcomes).toEqual([
      { status: "committed" },
      { status: "committed" },
      { status: "committed" },
    ]);
    unsubscribe();
    view.unmount();
  });
});
