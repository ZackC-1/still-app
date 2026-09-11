import { DEFAULT_SETTINGS, type StillSettings } from "@still/shared-types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SettingsCache } from "../../../storage/cache.js";
import {
  InMemoryStorageAdapter,
  type StorageAdapter,
} from "../../../storage/adapter.js";
import { SupabaseBackendPort } from "../../profile.js";
import { SyncService } from "../../service.js";
import {
  createExtensionSession,
  type PersistedSlot,
} from "../../extension-session.js";
import { InMemoryEntitlementAdapter } from "../../../entitlement/adapter.js";

export const A = "11111111-1111-1111-1111-111111111111";
export const B = "22222222-2222-2222-2222-222222222222";
export const drain = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
export const row = (settings: StillSettings, version: number, id: string) => ({
  settings,
  settings_version: version,
  settings_server_updated_at: new Date(
    1_800_000_000_000 + version,
  ).toISOString(),
  settings_last_write_id: id,
});

function responseGate() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const response = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {
    started,
    response,
    entered,
    resolve,
    reject: () => reject(new Error("offline")),
  };
}

export function harness(store: StorageAdapter = new InMemoryStorageAdapter()) {
  let user: string | null = A;
  let last: string | null = null;
  let now = 1_000;
  let nextWrite: ReturnType<typeof responseGate> | null = null;
  let nextRead: ReturnType<typeof responseGate> | null = null;
  let nextEntitlement: ReturnType<typeof responseGate> | null = null;
  let entitled = false;
  let nextSignOut: ReturnType<typeof responseGate> | null = null;
  let nextDelete: ReturnType<typeof responseGate> | null = null;
  const reads: string[] = [];
  const channels: {
    emit: (value: ReturnType<typeof row>) => void;
    status: (status: string) => void;
    closed: boolean;
  }[] = [];
  const rows = new Map([
    [A, row({ ...DEFAULT_SETTINGS, updatedAt: 100 }, 9, "a-initial")],
    [B, row({ ...DEFAULT_SETTINGS, updatedAt: 200 }, 1, "b-initial")],
  ]);
  const writes: { owner: string; settings: StillSettings }[] = [];
  const transport = {
    functions: {
      invoke: async (name: string) => {
        if (name === "delete-user") {
          const owner = user!;
          rows.delete(owner);
          const gate = nextDelete;
          nextDelete = null;
          if (gate) {
            gate.entered();
            await gate.response;
          }
        }
        return { data: {}, error: null };
      },
    },
    from: (table: string) => ({
      select: () => ({
        maybeSingle: async () => {
          if (table === "entitlements") {
            const data = { still_sync: entitled };
            const gate = nextEntitlement;
            nextEntitlement = null;
            if (gate) {
              gate.entered();
              await gate.response;
            }
            return { data, error: null };
          }
          const owner = user!;
          reads.push(owner);
          const data = structuredClone(rows.get(owner) ?? null);
          const gate = nextRead;
          nextRead = null;
          if (gate) {
            gate.entered();
            await gate.response;
          }
          return { data, error: null };
        },
      }),
    }),
    rpc: async (
      _name: string,
      args: { p_settings: StillSettings; p_write_id: string },
    ) => {
      if (!user) return { data: null, error: new Error("auth required") };
      // The request belongs to its JWT identity at dispatch. Its response can arrive later.
      const owner = user;
      const written = row(
        structuredClone(args.p_settings),
        (rows.get(owner)?.settings_version ?? 0) + 1,
        args.p_write_id,
      );
      rows.set(owner, written);
      writes.push({ owner, settings: written.settings });
      const gate = nextWrite;
      nextWrite = null;
      if (gate) {
        gate.entered();
        await gate.response;
      }
      return { data: [written], error: null };
    },
    channel: () => ({
      on: (
        _event: string,
        _filter: unknown,
        listener: (payload: { new: unknown }) => void,
      ) => ({
        subscribe: (status: (status: string) => void) => {
          const channel = {
            emit: (value: ReturnType<typeof row>) => listener({ new: value }),
            status,
            closed: false,
          };
          channels.push(channel);
          return {
            unsubscribe: async () => {
              channel.closed = true;
            },
          };
        },
      }),
    }),
  };
  const cache = new SettingsCache(store, { now: () => ++now });
  const auth = {
    currentUserId: async () => user,
    signInWithMagicLink: async () => ({}),
    signOut: async () => {
      user = null;
      const gate = nextSignOut;
      nextSignOut = null;
      if (gate) {
        gate.entered();
        await gate.response;
      }
    },
    requestCode: async () => ({ kind: "sent" as const }),
    verifyCode: async (email: string) => {
      user = email.startsWith("alice") ? A : B;
      return { kind: "verified" as const, userId: user };
    },
  };
  const identity = {
    get: async () => last,
    set: async (id: string) => {
      last = id;
    },
  };
  const backend = new SupabaseBackendPort(
    transport as unknown as SupabaseClient,
  );
  const sync = new SyncService(
    cache,
    auth,
    backend,
    undefined,
    identity,
    () => now,
  );
  function slot<T>(): PersistedSlot<T> {
    let value: T | null = null;
    return {
      get: async () => value,
      set: async (next) => {
        value = next;
      },
    };
  }
  const session = createExtensionSession({
    auth,
    backend,
    sync,
    identity,
    records: new InMemoryEntitlementAdapter(null, () => now),
    stores: { pendingOtp: slot(), checkoutPending: slot(), nudgeStamp: slot() },
    closeTab: async () => undefined,
    clearAuthStorage: async () => {
      user = null;
    },
    now: () => now,
  });
  return {
    cache,
    sync,
    session,
    rows,
    writes,
    reads,
    channels,
    store,
    holdSignOut: () => {
      nextSignOut = responseGate();
      return nextSignOut;
    },
    holdDelete: () => {
      nextDelete = responseGate();
      return nextDelete;
    },
    setEntitled: (value: boolean) => {
      entitled = value;
    },
    holdEntitlement: () => {
      nextEntitlement = responseGate();
      return nextEntitlement;
    },
    holdRead: () => {
      nextRead = responseGate();
      return nextRead;
    },
    holdWrite: () => {
      nextWrite = responseGate();
      return nextWrite;
    },
    resume: async (id: string) => {
      user = id;
      await sync.resume(id, false);
    },
    confirm: async (id: string) => {
      user = id;
      await sync.onEntitlementConfirmed(id, false);
    },
    signIn: async (id: string) => {
      user = id;
      await sync.onSignedIn(id);
    },
  };
}
