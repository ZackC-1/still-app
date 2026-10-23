import { describe, expect, it } from "vitest";
import { restoredCodeEntry } from "../pending-code-entry.js";

// The Apple app saves the pending code entry as JSON and reads it back on relaunch (ISS-0123).
describe("restoredCodeEntry", () => {
  it("brings back the sheet's purpose with the code entry", () => {
    for (const purpose of ["link", "purchase", "restore", "sync"] as const)
      expect(restoredCodeEntry(JSON.stringify({ email: "a@still.test", requestedAt: 5, purpose }), false)).toEqual({
        email: "a@still.test",
        requestedAt: 5,
        purchaseIntent: false,
        purpose,
      });
  });

  it("an older record, or an unknown purpose, restores without one", () => {
    expect(restoredCodeEntry(JSON.stringify({ email: "a@still.test", requestedAt: 5 }), true)).toEqual({
      email: "a@still.test",
      requestedAt: 5,
      purchaseIntent: true,
    });
    expect(restoredCodeEntry(JSON.stringify({ email: "a@still.test", purpose: "other" }), false)).toEqual({
      email: "a@still.test",
      purchaseIntent: false,
    });
  });

  it("nothing usable restores nothing", () => {
    expect(restoredCodeEntry(null, false)).toBeNull();
    expect(restoredCodeEntry("not json", false)).toBeNull();
    expect(restoredCodeEntry(JSON.stringify({ requestedAt: 5 }), false)).toBeNull();
    expect(restoredCodeEntry("[]", false)).toBeNull();
  });
});
