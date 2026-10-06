import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVED } from "./copy.js";

describe("owner page copy", () => {
  it("uses the D28 OwnerAllowances lines exactly", () => {
    expect(APPROVED.allowances.title).toBe("Rating prompt allowances");
    expect(APPROVED.allowances.body).toBe("Off everywhere until you allow it. Nothing changes until Apply.");
    expect(APPROVED.allowances.applied).toBe("Applied and read back. The server matches.");
    expect(APPROVED.allowances.stale).toBe("These changed since you loaded them. Reload to see the current state.");
    expect(APPROVED.allowances.failed).toBe("Apply didn't finish. Nothing changed.");
    expect(APPROVED.allowances.readback).toBe("Reading back the saved allowances…");
    expect(APPROVED.allowances.deferred).toBe("Deferred");
    expect(APPROVED.surfaces.edge_desktop).toBe("Edge desktop");
  });

  it("reuses shipped sign-in wording verbatim", () => {
    const strings = readFileSync(resolve(__dirname, "../../../packages/core/src/ui/strings.ts"), "utf8");
    for (const line of [
      APPROVED.signIn.send,
      APPROVED.signIn.codeLabel,
      APPROVED.signIn.verify,
      APPROVED.signIn.wrongCode,
      APPROVED.signIn.verifyError,
      APPROVED.signIn.sendError,
      APPROVED.signIn.invalidEmail,
      APPROVED.signIn.emailLabel,
      APPROVED.signIn.differentEmail,
      APPROVED.signIn.signOut,
    ]) {
      expect(strings, line).toContain(JSON.stringify(line));
    }
  });
});
