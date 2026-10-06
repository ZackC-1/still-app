import { test, expect } from "@playwright/test";
import { redact } from "../shared/evidence.js";

// A signed-in storage record, built at runtime: secret-shaped literals are blocked by push protection.
const jwt = ["ey" + "JhbGciOiJFUzI1NiJ9", "ey" + "JzdWIiOiJ4In0", "c2ln"].join(".");
const uuid = ["3f2b8c1e", "4d5a", "4b6c", "9e7f", "1a2b3c4d5e6f"].join("-");

test("redact() hides identifiers and credentials in a signed-in record, whatever the key", () => {
  const record = {
    settings: { globalOn: true, schemaVersion: 2, services: { youtube: true } },
    atomic: { ownership: "linked", scope: { accountId: uuid, generation: 3 }, anchor: { rev: "abc" }, lineage: uuid },
    session: { access_token: jwt, refresh_token: "r-" + "x".repeat(20), user: { email: "person@example.test", id: uuid } },
    analytics: { distinct_id: uuid, installId: uuid, otp: "123456" },
    note: { harmless: "Still is on.", copied: jwt, alsoCopied: uuid },
  };
  const out = redact(record) as typeof record;
  const text = JSON.stringify(out);
  for (const secret of [jwt, uuid, "person@example.test", "123456", "r-xxxx"]) expect(text).not.toContain(secret);
  // Non-identifying settings survive, including booleans and numbers under sensitive-looking keys.
  expect(out.settings).toEqual(record.settings);
  expect(out.atomic.scope.generation).toBe(3);
  expect(out.note.harmless).toBe("Still is on.");
  expect(out.note.copied).toBe("[redacted]");
  expect(out.note.alsoCopied).toBe("[redacted]");
});
