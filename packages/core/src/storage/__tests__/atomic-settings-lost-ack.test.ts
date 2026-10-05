import { describe, expect, it, vi } from "vitest";
import { AtomicSettingsWriter, pendingSettingsRequest } from "../atomic-settings.js";
import { A, SESSION, authority, canonical } from "./atomic-settings-test-fixtures.js";

// U3-W3: the background writer is terminated after its durable write and before its reply. A
// restarted writer (a new instance over the same storage, as after a worker wake) must find the
// saved choice, keep its one immutable request, and treat a duplicate delivery as a no-op.

async function linked() {
  const h = authority();
  await h.writer.initialize("unknown");
  const entered = await h.writer.enterScope(A, SESSION);
  await h.writer.acknowledge(canonical(entered, 1), entered.atomic!.scope);
  return h;
}

describe("lost acknowledgement between a durable write and its reply", () => {
  it("keeps one immutable request; a restarted writer's duplicate writes nothing and the retry body is unchanged", async () => {
    const h = await linked();
    const sent = await h.writer.commit({ path: "globalOn", value: false, updatedAt: 10 });
    const body = pendingSettingsRequest(sent.atomic!.pending[0]!, sent.atomic!);
    expect(body).not.toBeNull();
    // The reply is lost with the worker. A wake builds a new writer over the same storage.
    const restarted = new AtomicSettingsWriter(h.storage, () => { throw new Error("a duplicate must not allocate"); });
    const write = vi.spyOn(h.storage, "set");
    expect(await restarted.enterScope(A, SESSION)).toEqual(await h.storage.get());
    const duplicate = await restarted.commit({ path: "globalOn", value: false, updatedAt: 10 });
    expect(duplicate.intentCommitted).toBe(false);
    expect(write).not.toHaveBeenCalled();
    const after = (await h.storage.get())!;
    expect(after.settings.globalOn).toBe(false);
    expect(after.atomic!.sequence).toBe(sent.atomic!.sequence);
    expect(after.atomic!.pending).toHaveLength(1);
    expect(pendingSettingsRequest(after.atomic!.pending[0]!, after.atomic!)).toEqual(body);
  });

  it("at the pending limit a duplicate of the 64th choice neither queues nor pauses", async () => {
    const h = await linked();
    for (let i = 0; i < 63; i += 1)
      await h.writer.commit({ path: "globalOn", value: i % 2 === 1, updatedAt: 10 + i });
    const last = await h.writer.commit({ path: "globalOn", value: true, updatedAt: 100 });
    expect(last.atomic).toMatchObject({ paused: null, held: {} });
    expect(last.atomic!.pending).toHaveLength(64);
    const restarted = new AtomicSettingsWriter(h.storage, () => { throw new Error("a duplicate must not allocate"); });
    const write = vi.spyOn(h.storage, "set");
    expect((await restarted.commit({ path: "globalOn", value: true, updatedAt: 100 })).intentCommitted).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect((await h.storage.get())!.atomic).toMatchObject({ paused: null, held: {}, sequence: last.atomic!.sequence });
    // A genuinely different later choice is still kept (held), never dropped.
    const held = await restarted.commit({ path: "globalOn", value: false, updatedAt: 101 });
    expect(held.atomic).toMatchObject({ paused: "pending-limit", held: { globalOn: false } });
    expect(held.atomic!.pending).toHaveLength(64);
  });

  it("a saved local Off with unknown ownership survives the kill and a wake without being rewritten", async () => {
    const h = authority();
    await h.writer.initialize("unknown");
    const saved = await h.writer.commit({ path: "globalOn", value: false, updatedAt: 10 });
    expect(saved.intentCommitted).toBe(true);
    const restarted = new AtomicSettingsWriter(h.storage, () => { throw new Error("unknown local edits never allocate"); });
    const write = vi.spyOn(h.storage, "set");
    const bytes = JSON.stringify(await h.storage.get());
    await restarted.initialize("unknown");
    expect((await restarted.commit({ path: "globalOn", value: false, updatedAt: 10 })).intentCommitted).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(JSON.stringify(await h.storage.get())).toBe(bytes);
    expect((await h.storage.get())!.settings.globalOn).toBe(false);
  });
});
