import { afterEach, describe, expect, it, vi } from "vitest";
import { askProOfferReady } from "../pro-navigation.js";
import { CHECKOUT_AVAILABLE_ACTION } from "../checkout-availability.js";
import { SESSION_MESSAGE_KIND } from "../session-messages.js";

// The popup's "would Settings offer Get Still Pro?" question (ISS-0032) is the Settings card's
// question, asked with the same message, and anything but a literal true is "no".
afterEach(() => vi.unstubAllGlobals());

describe("askProOfferReady", () => {
  it.each([[true, true], [false, false], [undefined, false], ["true", false], [{ allowed: true }, false]] as const)(
    "reply %j → %s",
    async (reply, expected) => {
      const sendMessage = vi.fn(async () => reply);
      vi.stubGlobal("chrome", { runtime: { sendMessage } });
      expect(await askProOfferReady()).toBe(expected);
      expect(sendMessage).toHaveBeenCalledWith({ kind: SESSION_MESSAGE_KIND, action: CHECKOUT_AVAILABLE_ACTION });
    },
  );

  it("a failed or missing answer is no", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => { throw new Error("no receiver"); }) } });
    expect(await askProOfferReady()).toBe(false);
    vi.stubGlobal("chrome", { runtime: {} });
    expect(await askProOfferReady()).toBe(false);
  });
});
