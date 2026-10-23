import { describe, expect, it } from "vitest";
// A test-only reach into core (as before this test read strings.ts from disk): the page itself
// keeps its own copy and imports none of core's strings.
import { STRINGS } from "../../../packages/core/src/ui/strings.js";
import { APPROVED } from "./copy.js";

describe("owner page copy", () => {
  it("uses the D28 OwnerAllowances lines exactly", () => {
    expect(APPROVED.allowances.title).toBe("Rating prompt allowances");
    expect(APPROVED.allowances.body).toBe("Off everywhere until you allow it. Nothing changes until Apply.");
    expect(APPROVED.allowances.applied).toBe("Applied and read back. The server matches.");
    expect(APPROVED.allowances.stale).toBe("These changed since you loaded them. Reload to see the current state.");
    expect(APPROVED.allowances.failed).toBe("Apply didn’t finish. Nothing changed.");
    expect(APPROVED.allowances.readback).toBe("Reading back the saved allowances…");
    expect(APPROVED.allowances.deferred).toBe("Deferred");
    expect(APPROVED.surfaces.edge_desktop).toBe("Edge desktop");
  });

  it("reuses shipped sign-in wording verbatim", () => {
    // Compared with the shipped values, not the source text: some (the 6‑digit code label) are
    // built from a shared piece (ISS-0124).
    const shipped: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === "string") shipped.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(STRINGS);
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
      expect(shipped, line).toContain(line);
    }
    // The prompt is the shipped sync prompt's first sentence, 6‑digit with its non-breaking hyphen.
    expect(STRINGS.auth.prompt.startsWith(APPROVED.signIn.prompt)).toBe(true);
  });
});
