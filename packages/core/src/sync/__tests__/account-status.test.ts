import { expect, it } from "vitest";
import { parseAccountSyncStatus } from "../account-status.js";
const record = {
  accountId: "11111111-1111-1111-1111-111111111111", email: "test@example.com",
  lastSyncedAt: null, pendingUpload: false, cloudReachable: true, updatedAt: 100,
};
it("parses the native JSON record and only returns display fields", () => {
  expect(parseAccountSyncStatus(JSON.stringify({ ...record, unrelated: "discard" }))).toEqual(record);
});
it("refuses malformed fields and timestamps outside JavaScript's date range", () => {
  for (const invalid of [null, {}, "garbage", { ...record, accountId: "wrong" },
    { ...record, email: "a".repeat(321) }, { ...record, lastSyncedAt: -1 },
    { ...record, lastSyncedAt: 1e30 }, { ...record, updatedAt: NaN },
    { ...record, cloudReachable: "true" }, { ...record, pendingUpload: 1 }]) {
    expect(parseAccountSyncStatus(invalid)).toBeNull();
  }
});
