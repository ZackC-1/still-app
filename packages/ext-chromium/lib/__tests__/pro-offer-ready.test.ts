import { afterEach, describe, expect, it, vi } from "vitest";
import { askProOfferReady, lastProOfferReady, rememberProOfferReady, PRO_OFFER_READY_KEY } from "../pro-navigation.js";
import { CHECKOUT_AVAILABLE_ACTION } from "../checkout-availability.js";
import { SESSION_MESSAGE_KIND } from "../session-messages.js";

// The popup's "would Settings offer Get Still Pro?" question (ISS-0032) is the Settings card's
// question, asked with the same message, and anything but a literal true is "no".
afterEach(() => vi.unstubAllGlobals());

describe("askProOfferReady", () => {
  it.each([[true, true], [false, false], [undefined, undefined], ["true", false], [{ allowed: true }, false]] as const)(
    "reply %j → %s",
    async (reply, expected) => {
      const sendMessage = vi.fn(async () => reply);
      vi.stubGlobal("chrome", { runtime: { sendMessage } });
      expect(await askProOfferReady()).toBe(expected);
      expect(sendMessage).toHaveBeenCalledWith({ kind: SESSION_MESSAGE_KIND, action: CHECKOUT_AVAILABLE_ACTION });
    },
  );

  it("a failed, missing or late answer is no answer (ask again), never a no (ISS-0032)", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => { throw new Error("no receiver"); }) } });
    expect(await askProOfferReady()).toBeUndefined();
    vi.stubGlobal("chrome", { runtime: {} });
    expect(await askProOfferReady()).toBeUndefined();
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(() => new Promise(() => {})) } });
    expect(await askProOfferReady(10)).toBeUndefined();
  });

  it("remembers the last answer for this browser session, and reads anything else as no", async () => {
    const records: Record<string, unknown> = {};
    const session = {
      set: vi.fn(async (values: Record<string, unknown>) => Object.assign(records, values)),
      get: vi.fn(async (key: string) => ({ [key]: records[key] })),
    };
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => true) }, storage: { session } });
    expect(await lastProOfferReady()).toBe(false);
    expect(await askProOfferReady()).toBe(true);
    expect(session.set).not.toHaveBeenCalled();
    await rememberProOfferReady(true);
    expect(records[PRO_OFFER_READY_KEY]).toBe(true);
    expect(await lastProOfferReady()).toBe(true);
    records[PRO_OFFER_READY_KEY] = "true";
    expect(await lastProOfferReady()).toBe(false);
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => false) }, storage: { session } });
    expect(await askProOfferReady()).toBe(false);
    await rememberProOfferReady(false);
    expect(records[PRO_OFFER_READY_KEY]).toBe(false);
  });
});
