import { describe, expect, it } from "vitest";
import { SALES_OFFERS } from "@still/shared-types/product-policy";
import {
  STILL_PRO_WEB_OFFER_PRICES,
  formatOneTimePrice,
  stillProPriceLine,
} from "../still-pro-price.js";

// The Chrome/Firefox Still Pro card's price line (owner, 21 Oct): "$9.99 · one-time" under Get
// Still Pro, from the price configured for the reviewed sales offer, and nothing when that price
// cannot be read. The formatting rule lives in one place: formatOneTimePrice.
describe("formatOneTimePrice", () => {
  it("formats USD 9.99 exactly as the owner wrote it, with a spaced middle dot (U+00B7)", () => {
    const line = formatOneTimePrice({ currency: "USD", amountMinor: 999 });
    expect(line).toBe("$9.99 · one-time");
    expect(line).toBe("$9.99 · one-time");
  });

  it("keeps two decimals for a whole amount", () => {
    expect(formatOneTimePrice({ currency: "USD", amountMinor: 1000 })).toBe("$10.00 · one-time");
  });

  it.each([
    ["no price", null],
    ["an undefined price", undefined],
    ["a zero amount", { currency: "USD", amountMinor: 0 }],
    ["a negative amount", { currency: "USD", amountMinor: -999 }],
    ["a fractional minor amount", { currency: "USD", amountMinor: 9.99 }],
    ["an unsafe amount", { currency: "USD", amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ["a malformed currency", { currency: "usd", amountMinor: 999 }],
    ["an empty currency", { currency: "", amountMinor: 999 }],
  ] as const)("shows nothing for %s", (_name, price) => {
    expect(formatOneTimePrice(price as never)).toBeUndefined();
  });
});

describe("stillProPriceLine", () => {
  it("reads the price configured for the reviewed sales offer", () => {
    expect(stillProPriceLine("still-pro-v3")).toBe("$9.99 · one-time");
  });

  it("has an entry for every reviewed sales offer and nothing else", () => {
    expect(Object.keys(STILL_PRO_WEB_OFFER_PRICES).sort()).toEqual([...SALES_OFFERS].sort());
  });

  it("shows nothing for an offer whose price is not configured", () => {
    expect(stillProPriceLine("still-pro-v3", { "still-pro-v3": null })).toBeUndefined();
  });

  it("shows nothing for an offer it does not know", () => {
    expect(stillProPriceLine("still-pro-v9" as never)).toBeUndefined();
  });
});
