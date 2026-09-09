import { afterEach, expect, it, vi } from "vitest";
import { watchAccountStatus, type AccountStatusSnapshot } from "../account-status.js";
import { UiController } from "../controller.svelte.js";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";

const status: AccountStatusSnapshot = {
  accountId: "11111111-1111-1111-1111-111111111111", email: "test@example.com",
  lastSyncedAt: 100, pendingUpload: false, cloudReachable: true, updatedAt: 110,
};
const makeController = () => new UiController({ cache: new SettingsCache(new InMemoryStorageAdapter(null)), host: { canPurchase: false }, auth: { signOut: async () => {} } });
afterEach(() => vi.useRealTimers());

it("refreshes email and health, retains account on transport failure, clears on sign-out", async () => {
  vi.useFakeTimers();
  const controller = makeController();
  const read = vi.fn<() => Promise<AccountStatusSnapshot | null>>().mockResolvedValue(status);
  const stop = watchAccountStatus(controller, read);
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.accountEmail).toBe(status.email);
  expect(controller.lastSyncedAt).toBe(100);
  read.mockRejectedValueOnce(new Error("offline"));
  await vi.advanceTimersByTimeAsync(2000);
  expect(controller.cloudReachable).toBe(false);
  expect(controller.accountEmail).toBe(status.email);
  read.mockResolvedValue(null);
  await vi.advanceTimersByTimeAsync(2000);
  expect(controller.accountEmail).toBeNull();
  expect(controller.lastSyncedAt).toBeNull();
  stop();
});

it("does not revive the old account from a read started before sign-out", async () => {
  vi.useFakeTimers();
  let resolve!: (value: AccountStatusSnapshot) => void;
  const controller = makeController();
  const read = vi.fn(() => new Promise<AccountStatusSnapshot>((r) => { resolve = r; }));
  const stop = watchAccountStatus(controller, read);
  await vi.advanceTimersByTimeAsync(6000);
  expect(read).toHaveBeenCalledTimes(1);
  await controller.signOut();
  resolve(status);
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.accountEmail).toBeNull();
  expect(controller.userId).toBeNull();
  stop();
});

it("ignores late replies after the observer stops", async () => {
  let resolve!: (value: AccountStatusSnapshot) => void;
  const controller = makeController();
  const stop = watchAccountStatus(controller, () => new Promise((r) => { resolve = r; }));
  stop();
  resolve(status);
  await Promise.resolve();
  expect(controller.userId).toBeNull();
});
