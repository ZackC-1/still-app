import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { InMemoryStorageAdapter, type StoredSettingsRecord } from "../../storage/adapter.js";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { SettingsCache } from "../../storage/cache.js";
import { EntitlementCache } from "../../entitlement/cache.js";
import { initialAccessSnapshot } from "../../entitlement/access-policy.js";
import { createDesktopPopupBinding, type DesktopPopupCommandOutcome } from "./desktop-popup-binding.js";
import { observeDirectControls, type DirectControlSurface } from "./direct-control-observer.js";
import type { InvitationControl } from "../../invitations/ledger.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); });

const surface = (outcome: DesktopPopupCommandOutcome): DirectControlSurface => ({
  setGlobalOn: async () => outcome,
  setService: async () => outcome,
  setFeature: async () => outcome,
});

describe("observeDirectControls", () => {
  it("reports each committed change once, with its control kind", async () => {
    const seen: InvitationControl[] = [];
    const wrapped = observeDirectControls(surface({ status: "committed" }), c => seen.push(c));
    await wrapped.setGlobalOn(false);
    await wrapped.setService("youtube", false);
    await wrapped.setFeature("youtube.comments", true);
    expect(seen).toEqual(["global", "site", "feature"]);
  });

  it.each<[string, DesktopPopupCommandOutcome]>([
    ["unchanged", { status: "not-committed" }],
    ["refused", { status: "rejected", reason: "inactive-or-unavailable" }],
    ["invalid", { status: "rejected", reason: "invalid-input" }],
    ["failed write", { status: "unavailable", reason: "write-failed" }],
  ])("does not report a %s request", async (_name, outcome) => {
    const seen: InvitationControl[] = [];
    const wrapped = observeDirectControls(surface(outcome), c => seen.push(c));
    expect(await wrapped.setService("youtube", false)).toEqual(outcome);
    await wrapped.setGlobalOn(true);
    await wrapped.setFeature("youtube.comments", true);
    expect(seen).toEqual([]);
  });

  it("returns the saved outcome unchanged even if reporting throws", async () => {
    const wrapped = observeDirectControls(surface({ status: "committed" }), () => { throw new Error("worker gone"); });
    expect(await wrapped.setGlobalOn(false)).toEqual({ status: "committed" });
  });
});

describe("against the real binding and storage writer", () => {
  async function fixture() {
    const storage = new InMemoryStorageAdapter(DEFAULT_SETTINGS);
    let id = 0;
    const writer = new AtomicSettingsWriter(storage, () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`);
    const record = await writer.initialize("never-linked");
    const settings = new SettingsCache({
      get: storage.get.bind(storage), set: storage.set.bind(storage), subscribe: storage.subscribe.bind(storage),
      commitIntent: intent => writer.commit(intent),
    }, { now: () => 100 });
    await settings.hydrate();
    const access = new EntitlementCache(
      { get: async () => false, set: async () => {}, subscribe: () => () => {}, observeBenefits: async () => initialAccessSnapshot() },
      {},
    );
    await access.refreshAccess();
    cleanups.push(settings.watch(), access.watch());
    const binding = createDesktopPopupBinding(settings, access);
    cleanups.push(binding.stop);
    return { storage, record, binding };
  }

  it("counts a real committed toggle and not an unchanged one", async () => {
    const f = await fixture();
    const seen: InvitationControl[] = [];
    const wrapped = observeDirectControls(f.binding, c => seen.push(c));
    expect(await wrapped.setService("youtube", false)).toEqual({ status: "committed" });
    expect(await wrapped.setService("youtube", false)).toEqual({ status: "not-committed" });
    expect(seen).toEqual(["site"]);
  });

  it("does not count a change that arrives from elsewhere (sync or another page)", async () => {
    const f = await fixture();
    const seen: InvitationControl[] = [];
    observeDirectControls(f.binding, c => seen.push(c));
    const states: boolean[] = [];
    f.binding.subscribe(s => states.push(s.settings?.services.youtube ?? true));
    const durable = (await f.storage.get()) as StoredSettingsRecord;
    const settings = durable.settings as typeof DEFAULT_SETTINGS & { schemaVersion: 2 };
    f.storage.emitExternal({ ...durable, settings: { ...settings, services: { ...settings.services, youtube: false } } } as StoredSettingsRecord);
    // The view really saw the changed choice; nothing was counted.
    expect(states).toContain(false);
    expect(seen).toEqual([]);
  });
});
