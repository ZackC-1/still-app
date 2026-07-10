import { describe, it, expect } from "vitest";
import { isValidEmail } from "../email.js";

describe("isValidEmail", () => {
  it("accepts ordinary addresses (trimming surrounding whitespace)", () => {
    for (const good of ["you@email.com", "a.b+tag@sub.example.co", "  x@y.io  "]) {
      expect(isValidEmail(good)).toBe(true);
    }
  });

  it("rejects malformed or incomplete addresses", () => {
    for (const bad of ["", "   ", "nope", "a@b", "a@b.", "@b.com", "a b@c.com", "a@@b.com"]) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });
});
