// Shared UI configuration constants.

/**
 * The hosted privacy-policy URL, linked in-app (App Store Guideline 5.1.1 also requires it in the
 * App Store Connect metadata). Served by GitHub Pages from the `gh-pages` branch, which uses
 * directory-style pretty URLs (`/privacy/`, not `/privacy.html`). The same URL must be entered in
 * the App Store Connect "Privacy Policy URL" field. If a custom domain is added later
 * (e.g. https://still.app/privacy), update this constant + the ASC field together.
 */
export const PRIVACY_POLICY_URL = "https://zackc-1.github.io/still-app/privacy/";

/**
 * Support contact for purchase recovery (plan U4). "Find my purchase" is a support mailto for v1
 * [DECIDED — docs/monetization-design.md]: when a checkout-pending flag decays past 24h without
 * the server ever confirming the purchase, the paywall offers this instead of an infinite spinner.
 * Same address as the App Store support listing.
 */
export const SUPPORT_EMAIL = "zack@cadmuslabs.co";
export const FIND_MY_PURCHASE_MAILTO = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Find my purchase")}`;
