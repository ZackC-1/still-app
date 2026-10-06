import { describe, expect, it } from "vitest";
import { createTeardownGeneration } from "../teardown-generation.js";

describe("teardown generation", () => {
  it("a fresh capture reads as current until a teardown lands", () => {
    const generations = createTeardownGeneration();
    const token = generations.capture();
    expect(generations.isCurrent(token)).toBe(true);
    generations.bump();
    expect(generations.isCurrent(token)).toBe(false);
  });

  it("a capture taken after the bump is current again", () => {
    const generations = createTeardownGeneration();
    generations.bump();
    const token = generations.capture();
    expect(generations.isCurrent(token)).toBe(true);
  });

  it("interleaved spans stay independent: only pre-bump captures go stale", () => {
    const generations = createTeardownGeneration();
    const before = generations.capture();
    generations.bump();
    const after = generations.capture();
    generations.bump();
    expect(generations.isCurrent(before)).toBe(false);
    expect(generations.isCurrent(after)).toBe(false);
    expect(generations.isCurrent(generations.capture())).toBe(true);
  });

  it("instances do not share state", () => {
    const first = createTeardownGeneration();
    const second = createTeardownGeneration();
    const token = first.capture();
    second.bump();
    expect(first.isCurrent(token)).toBe(true);
  });
});
