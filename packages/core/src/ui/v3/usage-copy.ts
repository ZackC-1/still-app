// The V3 "Share usage data" switch: the one usage-data control on every V3 screen (owner, 12 Oct
// 2026; ADR 0004 "V3 consent"). There is no one-time notice next to it any more: the switch shows
// sharing on from the first screen and is the off path. The subtext must stay true to the closed
// event schema (analytics/events.ts): no event names a page, video, search or a site someone
// visited, and nothing is sent from the sites themselves.
//
// The 2.x screens keep STRINGS.usage (strings.ts) unchanged, so shipped 2.x bundles stay
// byte-for-byte as they were. The title is the same on both (a test pins it to STRINGS.usage.title);
// it is written out here because reading it from STRINGS would keep this object in 2.x bundles.
export const USAGE_SWITCH_COPY = {
  title: "Share usage data",
  body: "Helps to improve Still. Never shares the websites you visit or website activity.",
} as const;
