import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseBackendPort } from "../profile.js";

// Pins the realtime binding of subscribeToProfile. The FIRST cloud write for a user is an INSERT
// (write_profile_settings' insert…on conflict path creates the profiles row — nothing else does),
// so an UPDATE-only stream misses another device's first write until a reconnect.

type ChangeHandler = (payload: { new: unknown }) => void;

function fakeRealtimeClient() {
  const bindings: Array<{ filter: Record<string, unknown>; handler: ChangeHandler }> = [];
  const channel = {
    on(_type: string, filter: Record<string, unknown>, handler: ChangeHandler) {
      bindings.push({ filter, handler });
      return channel;
    },
    subscribe: vi.fn(() => channel),
    unsubscribe: vi.fn(() => Promise.resolve("ok")),
  };
  const client = { channel: vi.fn(() => channel) } as unknown as SupabaseClient;
  return { client, bindings, channel };
}

const envelopeRow = {
  settings: {
    globalOn: true,
    services: { youtube: true, instagram: false, tiktok: false, facebook: false },
    pauses: [],
    updatedAt: 5,
  },
  settings_version: 1,
  settings_server_updated_at: "2026-07-09T00:00:00.000Z",
  settings_last_write_id: null,
};

describe("SupabaseBackendPort.subscribeToProfile", () => {
  it("listens for INSERT as well as UPDATE (event: *) on the user's profile row", () => {
    const { client, bindings } = fakeRealtimeClient();
    const port = new SupabaseBackendPort(client);
    const onEnvelope = vi.fn();
    port.subscribeToProfile("user-1", onEnvelope);

    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.filter).toMatchObject({
      event: "*",
      schema: "public",
      table: "profiles",
      filter: "id=eq.user-1",
    });

    // A first-write INSERT payload must reach the listener as a parsed envelope.
    bindings[0]!.handler({ new: envelopeRow });
    expect(onEnvelope).toHaveBeenCalledTimes(1);
    expect(onEnvelope.mock.calls[0]![0]).toMatchObject({ version: 1 });
  });

  it("drops rows that do not parse into an envelope", () => {
    const { client, bindings } = fakeRealtimeClient();
    const port = new SupabaseBackendPort(client);
    const onEnvelope = vi.fn();
    port.subscribeToProfile("user-1", onEnvelope);
    bindings[0]!.handler({ new: { settings: "garbage" } });
    expect(onEnvelope).not.toHaveBeenCalled();
  });
});

// And the profile READ, where one distinction is load-bearing: the reconcile is allowed to start an
// account that has nothing saved in it from scratch, so "there is no row" and "the row could not be
// read" have to arrive as different answers.

function fakeProfileClient(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({
        maybeSingle: () => Promise.resolve(result),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("SupabaseBackendPort.readProfile", () => {
  it("reports an account with nothing saved as null", async () => {
    const port = new SupabaseBackendPort(fakeProfileClient({ data: null, error: null }));
    await expect(port.readProfile()).resolves.toBeNull();
  });

  it("raises a failed read rather than passing it on as an account with nothing saved", async () => {
    // A browser that could not reach the server would otherwise look exactly like a browser signing
    // into a brand new account, and be treated as one.
    const port = new SupabaseBackendPort(fakeProfileClient({ data: null, error: new Error("offline") }));
    await expect(port.readProfile()).rejects.toThrow("offline");
  });
});

describe("SupabaseBackendPort.deleteAccount", () => {
  function deletionPort(data: unknown, error: unknown = null) {
    const invoke = vi.fn(async () => ({ data, error }));
    const client = { functions: { invoke } } as unknown as SupabaseClient;
    return { port: new SupabaseBackendPort(client), invoke };
  }

  it.each([true, false, null])("retains the reported legacy analytics deletion result %s", async (analyticsDeleted) => {
    const { port, invoke } = deletionPort({ deleted: true, analyticsDeleted });
    await expect(port.deleteAccount()).resolves.toEqual({ deleted: true, analyticsDeleted, analyticsErasure: "unconfirmed" });
    expect(invoke).toHaveBeenCalledWith("delete-user", {
      body: {}, signal: expect.any(AbortSignal),
    });
  });

  it("keeps an older response without analytics status unreported", async () => {
    await expect(deletionPort({ deleted: true }).port.deleteAccount())
      .resolves.toEqual({ deleted: true, analyticsDeleted: null, analyticsErasure: "unconfirmed" });
  });

  it.each([null, {}, [], { deleted: false }, { deleted: "true" }])("rejects an unconfirmed or malformed success body %j", async (data) => {
      await expect(deletionPort(data).port.deleteAccount()).rejects.toThrow("Account deletion is unconfirmed");
  });

  it("does not lose a confirmed account deletion to malformed optional analytics metadata", async () => {
    await expect(deletionPort({ deleted: true, analyticsDeleted: "true", analyticsErasure: "completed" }).port.deleteAccount())
      .resolves.toEqual({ deleted: true, analyticsDeleted: null, analyticsErasure: "unconfirmed" });
  });

  it("propagates an invocation failure even when the body claims deletion", async () => {
    await expect(deletionPort({ deleted: true, analyticsDeleted: true }, new Error("offline")).port.deleteAccount())
      .rejects.toThrow("offline");
  });
});

describe("modern settings invalidation", () => {
  it("receives only private QA hints, removes its channel and fences delayed callbacks", () => {
    let receive!: (message: unknown) => void;
    let status!: (value: string) => void;
    const channel = { on: vi.fn((_type, _filter, listener) => { receive = listener; return channel; }),
      subscribe: vi.fn(listener => { status = listener; return channel; }) };
    const client = { channel: vi.fn(() => channel), removeChannel: vi.fn(async () => "ok") };
    const port = new SupabaseBackendPort(client as unknown as SupabaseClient,
      { modernSettings: true, routeProfile: "shared-hosted-sandbox" });
    const changed = vi.fn(), state = vi.fn();
    const stop = port.subscribeToSettingsChanges("11111111-1111-1111-1111-111111111111", changed, state);
    expect(client.channel).toHaveBeenCalledWith("qa-settings-v1:11111111-1111-1111-1111-111111111111", { config: { private: true } });
    expect(channel.on).toHaveBeenCalledWith("broadcast", { event: "settings-changed" }, expect.any(Function));
    receive({ payload: { schema: 1 } });
    expect(changed).toHaveBeenCalledExactlyOnceWith();
    receive({ payload: { schema: 2 } }); receive({ payload: null });
    expect(changed).toHaveBeenCalledTimes(1);
    status("SUBSCRIBED"); expect(state).toHaveBeenLastCalledWith("subscribed");
    status("CHANNEL_ERROR"); expect(state).toHaveBeenLastCalledWith("error");
    stop(); stop();
    receive({ payload: { schema: 1 } }); status("SUBSCRIBED");
    expect(changed).toHaveBeenCalledTimes(1); expect(state).toHaveBeenCalledTimes(2);
    expect(client.removeChannel).toHaveBeenCalledExactlyOnceWith(channel);
  });

  it("keeps production on its existing profile notification with no settings passed to the hint", () => {
    const { client, bindings } = fakeRealtimeClient();
    const port = new SupabaseBackendPort(client, { modernSettings: true });
    const changed = vi.fn();
    port.subscribeToSettingsChanges("user-1", changed);
    expect(bindings[0]!.filter).toMatchObject({ table: "profiles", filter: "id=eq.user-1" });
    bindings[0]!.handler({ new: envelopeRow });
    expect(changed).toHaveBeenCalledExactlyOnceWith();
  });
});
