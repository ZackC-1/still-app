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
