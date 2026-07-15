import { describe, expect, it } from "vitest";
import seed from "../../../rules/seed.json";
import type { SignedRuleSet } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { createEnginePageSession } from "../engine.js";

const ruleSet = seed as unknown as SignedRuleSet;

describe("createEnginePageSession", () => {
  it("reuses the same prepared decision for unchanged page inputs", () => {
    const session = createEnginePageSession(ruleSet);
    const url = new URL("https://www.youtube.com/feed/subscriptions");

    expect(session.evaluate(DEFAULT_SETTINGS, url, { pro: false })).toEqual({ kind: "apply" });
    expect(session.evaluate(DEFAULT_SETTINGS, url, { pro: false })).toEqual({ kind: "apply" });
    expect(session.debugStats().serviceResolutions).toBe(1);
  });

  it("invalidates preparation when URL, settings identity, or entitlement changes", () => {
    const session = createEnginePageSession(ruleSet);
    session.evaluate(DEFAULT_SETTINGS, new URL("https://www.youtube.com/"), { pro: false });
    session.evaluate({ ...DEFAULT_SETTINGS }, new URL("https://www.youtube.com/"), { pro: false });
    session.evaluate(DEFAULT_SETTINGS, new URL("https://www.youtube.com/feed/subscriptions"), { pro: false });
    session.evaluate(DEFAULT_SETTINGS, new URL("https://www.youtube.com/feed/subscriptions"), { pro: true });

    expect(session.debugStats().serviceResolutions).toBe(4);
  });

  it("reuses prepared surfaces for repeated DOM application", () => {
    const session = createEnginePageSession(ruleSet);
    const url = new URL("https://www.youtube.com/feed/subscriptions");
    document.body.innerHTML = "<ytd-reel-shelf-renderer></ytd-reel-shelf-renderer>";

    expect(session.applyRemovals(DEFAULT_SETTINGS, url, document, { pro: false }).removed).toBe(1);
    expect(session.applyRemovals(DEFAULT_SETTINGS, url, document, { pro: false }).removed).toBe(0);
    expect(session.debugStats().serviceResolutions).toBe(1);
  });
});
