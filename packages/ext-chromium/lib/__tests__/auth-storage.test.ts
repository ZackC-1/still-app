import { afterEach, expect, it, vi } from "vitest";
import { AtomicSettingsWriter } from "@still/core/storage";
import {
  AUTH_STORAGE_KEY,
  clearExtensionAuthStorage,
  createAuthStorage,
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
