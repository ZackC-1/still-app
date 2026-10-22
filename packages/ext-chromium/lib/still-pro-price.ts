// The Chrome/Firefox Still Pro card's price line (owner, 21 Oct 2026): "$9.99 · one-time" under
// Get Still Pro. Browser builds only, never shared core: no web price may reach an Apple-target
// bundle (3.1.3 anti-steering; see LEGACY_WEB_DISPLAY_PRICE in purchase-wiring.ts). Only the paid
// settings card (InformationalProSettings, loaded in paid-tier builds) reads it.

/** The reviewed sales offer ids (shared-types' SALES_OFFERS). Restated here, not imported: only the
 * remote policy's evaluator and runtime may import its grammar (a dormancy test in core pins that);
 * lib/__tests__/still-pro-price.test.ts pins the two lists equal. */
export type SalesOffer = "still-pro-v3";

/** A price in the currency's minor unit (cents for USD), so no float ever reaches the display. */
export interface OfferPrice {
  /** ISO 4217 code, upper case. */
  readonly currency: string;
  readonly amountMinor: number;
}

/**
 * The price of each reviewed sales offer (shared-types' SALES_OFFERS), keyed
 * by the offer id the remote sales policy may name. `null` shows no price line.
 *
 * RELEASE PR: WIRE THIS TO THE CONFIGURED PRICE. No configured price source reaches a browser
 * build today: the remote sales policy grammar deliberately carries no prices (only the offer
 * id), the RevenueCat Web Purchase Link that create-web-checkout opens returns no price to the
 * extension, and no build constant names the V3 price. Until a configured source exists, this
 * table is that single source. It must equal the price configured for the offer in RevenueCat Web
 * Billing (D514: Still Pro $9.99 one-time); change it with that configuration, or set the entry to
 * null to show no price.
 */
export const STILL_PRO_WEB_OFFER_PRICES: Readonly<Record<SalesOffer, OfferPrice | null>> = Object.freeze({
  "still-pro-v3": Object.freeze({ currency: "USD", amountMinor: 999 }),
});

/**
 * The one formatting rule for the card's price line: "$9.99 · one-time" (a spaced U+00B7 middle
 * dot). Undefined for anything that is not a usable price, so the card shows nothing rather than a
 * placeholder or a wrong number.
 */
export function formatOneTimePrice(price: OfferPrice | null | undefined): string | undefined {
  if (!price || !/^[A-Z]{3}$/.test(price.currency)) return undefined;
  const { amountMinor } = price;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return undefined;
  try {
    const amount = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: price.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amountMinor / 100);
    return `${amount} · one-time`;
  } catch {
    return undefined;
  }
}

/** The price line for a reviewed sales offer, or undefined when its price is not configured. */
export function stillProPriceLine(
  offer: SalesOffer = "still-pro-v3",
  prices: Readonly<Partial<Record<SalesOffer, OfferPrice | null>>> = STILL_PRO_WEB_OFFER_PRICES,
): string | undefined {
  return Object.prototype.hasOwnProperty.call(prices, offer) ? formatOneTimePrice(prices[offer]) : undefined;
}
