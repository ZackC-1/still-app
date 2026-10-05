import { describe, expect, it } from "vitest";
import vectors from "./invitation-ledger-vectors.json";
import { runScenario, type VectorScenario } from "./vector-runner.js";
import { civilDayOrdinal, localDayOrdinal } from "../day-ordinal.js";
import { parseInvitationLedger } from "../ledger.js";

describe("shared invitation ledger vectors (TS side; StillKit runs the same file)", () => {
  for (const scenario of vectors.scenarios as unknown as VectorScenario[]) {
    it(scenario.name, () => {
      const { ledger, failures } = runScenario(scenario);
      expect(failures).toEqual([]);
      expect(scenario.final, "every scenario pins its full final ledger").toBeDefined();
      expect(ledger).toEqual(scenario.final);
      // The final ledger round-trips through the strict stored-record parser.
      expect(parseInvitationLedger(JSON.parse(JSON.stringify(ledger)))).toEqual(ledger);
    });
  }
  for (const d of vectors.dayOrdinals) {
    it(`local day ordinal: ${d.name}`, () => expect(localDayOrdinal(d.epochMs, d.timeZone)).toBe(d.ordinal));
  }
  it("civil day ordinals match Date.UTC", () => {
    for (const c of vectors.civilDates) {
      expect(civilDayOrdinal(c.year, c.month, c.day)).toBe(c.ordinal);
      expect(c.ordinal).toBe(Date.UTC(c.year, c.month - 1, c.day) / 86_400_000);
    }
  });
  for (const p of vectors.parse) {
    it(`strict parse: ${p.name}`, () => expect(parseInvitationLedger(p.value) !== null).toBe(p.valid));
  }
});
