import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { readAccountStatus } from "../account-status.js";

const status = {
  accountId: "11111111-1111-1111-1111-111111111111", email: "test@example.com",
  lastSyncedAt: 50, pendingUpload: false, cloudReachable: true, updatedAt: 100,
};
const local = { settings: { ...DEFAULT_SETTINGS, updatedAt: 75 }, syncMetadata: null };
function install(account: unknown, app = local) {
  const send = vi.fn(async (_host, message) => message.kind === "getAccountSyncStatus"
    ? { accountSyncStatus: account } : { settings: JSON.stringify(app) });
  vi.stubGlobal("browser", { runtime: { sendNativeMessage: send } });
  return send;
}
afterEach(() => vi.unstubAllGlobals());
it("reads the app's identity without storing it and reports matching local settings", async () => {
  const send = install(JSON.stringify(status));
  await expect(readAccountStatus(local)).resolves.toEqual({ ...status, extensionMatchesApp: true });
  expect(send.mock.calls.map((call) => call[1].kind).sort()).toEqual(["get", "getAccountSyncStatus"]);
});
it("reports a newer app-group edit as pending even if the app's last status was successful", async () => {
  const changed = { ...local, settings: { ...local.settings, updatedAt: 101 } };
  install(JSON.stringify(status), changed);
  await expect(readAccountStatus(changed)).resolves.toMatchObject({ pendingUpload: true });
});
it("reports Safari settings that differ from the app as pending", async () => {
  install(JSON.stringify(status));
  await expect(readAccountStatus({ ...local, settings: { ...local.settings, globalOn: false } })).resolves.toMatchObject({ extensionMatchesApp: false, pendingUpload: true });
});
it("clears the old account on a native signed-out reply", async () => {
  install(null);
  await expect(readAccountStatus(local)).resolves.toBeNull();
});
it("rejects corrupt or unavailable status instead of claiming signed-out or synced", async () => {
  install("broken");
  await expect(readAccountStatus(local)).rejects.toThrow();
});
it("compares effective settings after the existing parser clears a legacy native pause", async () => {
  install(JSON.stringify(status), { ...local, settings: { ...local.settings, pauses: ["youtube.com"] } });
  await expect(readAccountStatus(local)).resolves.toMatchObject({ extensionMatchesApp: true, pendingUpload: false });
});
it("compares the app with the page's settings as they are when the reads answer (ISS-0050)", async () => {
  // A switch saved while this poll waited its turn reaches the app and the page alike.
  const saved = { ...local, settings: { ...local.settings, globalOn: false, updatedAt: 90 } };
  install(JSON.stringify(status), saved);
  let current = local;
  const reading = readAccountStatus(() => current);
  current = saved;
  await expect(reading).resolves.toMatchObject({ extensionMatchesApp: true, pendingUpload: false });
});
it("reads the account and settings one after the other, never overlapping", async () => {
  let outstanding = 0, peak = 0;
  const send = vi.fn(async (_host: string, message: { kind: string }) => {
    peak = Math.max(peak, ++outstanding);
    await new Promise((resolve) => setTimeout(resolve, 5));
    outstanding--;
    return message.kind === "getAccountSyncStatus" ? { accountSyncStatus: JSON.stringify(status) } : { settings: JSON.stringify(local) };
  });
  vi.stubGlobal("browser", { runtime: { sendNativeMessage: send } });
  await expect(readAccountStatus(local)).resolves.toMatchObject({ extensionMatchesApp: true });
  expect(peak).toBe(1);
});
