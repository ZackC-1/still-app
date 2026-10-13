import { afterEach, expect, it, vi } from "vitest";
import { AtomicSettingsWriter } from "@still/core/storage";
import {
  AUTH_STORAGE_KEY,
  clearExtensionAuthStorage,
  createAuthStorage,
  persistedAuthAbsent,
  readAccessSession,
} from "../auth-storage.js";
const boundary = vi.hoisted(() => ({
  local: {} as typeof chrome.storage.local,
}));
vi.mock("wxt/browser", () => ({
  browser: {
    storage: {
      get local() {
        return boundary.local;
      },
    },
  },
}));
afterEach(() => vi.clearAllMocks());

it("SDK set/remove and offline teardown wait for the settings writer's durable transaction", async () => {
  const values: Record<string, unknown> = {};
  const set = vi.fn(async (entries: Record<string, unknown>) => {
    Object.assign(values, entries);
  });
  const remove = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
  });
  boundary.local = {
    get: async (key: string) => ({ [key]: values[key] }),
    set,
    remove,
  } as unknown as typeof chrome.storage.local;
  const writer = new AtomicSettingsWriter({
    get: async () => null,
    set: vi.fn(),
    subscribe: () => () => {},
  });
  const order = writer.serializeLocalMutation.bind(writer);
  const storage = createAuthStorage(order);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prior = order(() => wait);
  const saved = storage.setItem(AUTH_STORAGE_KEY, "session");
  const removed = storage.removeItem(`${AUTH_STORAGE_KEY}-code-verifier`);
  const cleared = clearExtensionAuthStorage(order);
  await Promise.resolve();
  expect(set).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  release();
  await prior;
  await saved;
  await removed;
  await cleared;
  expect(set).toHaveBeenCalledWith({ [AUTH_STORAGE_KEY]: "session" });
  expect(remove.mock.calls).toEqual([
    [`${AUTH_STORAGE_KEY}-code-verifier`],
    [[AUTH_STORAGE_KEY, `${AUTH_STORAGE_KEY}-code-verifier`]],
  ]);
  expect(values).toEqual({});
});

it("defensive auth storage preserves best-effort semantics when the ordered mutation rejects", async () => {
  const set = vi.fn();
  const remove = vi.fn();
  boundary.local = {
    get: async () => {
      throw new Error("read failed");
    },
    set,
    remove,
  } as unknown as typeof chrome.storage.local;
  const reject = async <T>(_mutation: () => Promise<T>): Promise<T> => {
    throw new Error("queue failed");
  };
  const storage = createAuthStorage(reject);
  expect(await storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  await storage.setItem(AUTH_STORAGE_KEY, "session");
  await storage.removeItem(AUTH_STORAGE_KEY);
  await clearExtensionAuthStorage(reject);
  expect(set).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

const verifiedSession = { userId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222" };
function sources(over: Partial<Parameters<typeof readAccessSession>[0]> = {}) {
  return {
    getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    currentSettingsSession: vi.fn(async () => verifiedSession),
    persistedAuthAbsent: vi.fn(async () => true),
    ...over,
  };
}

it("Still Pro access session: signed out is null only when the SDK and storage both say so (ISS-0030)", async () => {
  expect(await readAccessSession(sources())).toBeNull();
  // A persisted record the SDK did not return, or storage that cannot be read: unavailable.
  expect(await readAccessSession(sources({ persistedAuthAbsent: async () => false }))).toBeUndefined();
  expect(await readAccessSession(sources({ persistedAuthAbsent: async () => { throw new Error("torn"); } }))).toBeUndefined();
  // An SDK error is unavailable, never signed out, and storage is not consulted.
  const failed = sources({ getSession: vi.fn(async () => ({ data: { session: null }, error: new Error("refresh") })) });
  expect(await readAccessSession(failed)).toBeUndefined();
  expect(failed.persistedAuthAbsent).not.toHaveBeenCalled();
  // Signed in: the verified claims, or unavailable when they do not verify.
  const live = { getSession: vi.fn(async () => ({ data: { session: {} }, error: null })) };
  expect(await readAccessSession(sources(live))).toEqual(verifiedSession);
  expect(await readAccessSession(sources({ ...live, currentSettingsSession: async () => null }))).toBeUndefined();
});

it("persisted auth is absent only on a successful read without the auth record", async () => {
  const values: Record<string, unknown> = {};
  boundary.local = { get: async (key: string) => ({ [key]: values[key] }) } as unknown as typeof chrome.storage.local;
  expect(await persistedAuthAbsent()).toBe(true);
  values[AUTH_STORAGE_KEY] = "synthetic-session";
  expect(await persistedAuthAbsent()).toBe(false);
  boundary.local = { get: async () => { throw new Error("storage unavailable"); } } as unknown as typeof chrome.storage.local;
  expect(await persistedAuthAbsent()).toBe(false);
});
