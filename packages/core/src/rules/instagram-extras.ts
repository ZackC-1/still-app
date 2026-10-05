import type { ServiceExtras } from "./extras.js";

/**
 * Instagram's Still Pro extras: hide surfaces (copied into the packaged rule set by sign-format2.mjs),
 * compiled routes and marker adapters. Each entry ships with the code and tests that implement
 * its feature, and every entry stays dormant while the paid tier is off (accessCapabilities).
 * Surface ids must never reuse a free surface id, and surfaces may target only this service's
 * Still Pro features (rules/__tests__/extras-free-protection.test.ts).
 */
export const INSTAGRAM_EXTRAS: ServiceExtras = Object.freeze({
  surfaces: Object.freeze([]),
  routes: Object.freeze([]),
  markers: Object.freeze([]),
});
