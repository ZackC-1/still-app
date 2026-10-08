// Shared description of the synthetic fixtures for the 12 dormant Pro extras. Used by the core
// helper tests and by the Playwright extras specs. Dependency-free on purpose (node:fs only) so
// both runners can import it. Fixtures live in tests/fixtures/extras/; their selector families are
// UNVERIFIED candidates (see each file's header), never contracts.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ExtrasService = "youtube" | "instagram" | "facebook";

/** A fixture served at one URL. `ids` come from the page itself: "target-*" and "keep-*". */
export interface ExtrasPage {
  readonly file: string;
  readonly url: string;
  /** Marks routes whose address a dormant build must leave exactly as typed. */
  readonly route?: true;
}

export interface ExtrasControl {
  readonly feature: string;
  readonly service: ExtrasService;
  readonly pages: readonly ExtrasPage[];
}

const yt = "https://www.youtube.com";
const ig = "https://www.instagram.com";
const fb = "https://www.facebook.com";

export const EXTRAS_CONTROLS: readonly ExtrasControl[] = [
  { feature: "youtube.related", service: "youtube", pages: [
    { file: "yt-watch-related.html", url: `${yt}/watch?v=inv000000` },
    { file: "yt-m-watch-related.html", url: "https://m.youtube.com/watch?v=inv100000" },
  ] },
  { feature: "youtube.endscreen", service: "youtube", pages: [
    { file: "yt-watch-end.html", url: `${yt}/watch?v=inv200000` },
  ] },
  { feature: "youtube.autoplay", service: "youtube", pages: [
    { file: "yt-autoplay.html", url: `${yt}/watch?v=inv300001` },
    { file: "yt-autoplay.html", url: `${yt}/watch?v=inv300003&list=PLinvented03&index=2`, route: true },
    { file: "yt-m-autoplay.html", url: "https://m.youtube.com/watch?v=inv300001" },
    { file: "yt-m-autoplay.html", url: "https://m.youtube.com/watch?v=inv300003&list=PLinvented03&index=2", route: true },
  ] },
  { feature: "youtube.comments", service: "youtube", pages: [
    { file: "yt-watch-comments-chat.html", url: `${yt}/watch?v=inv400000` },
    { file: "yt-m-watch-comments.html", url: "https://m.youtube.com/watch?v=inv400000" },
  ] },
  { feature: "youtube.livechat", service: "youtube", pages: [
    { file: "yt-watch-comments-chat.html", url: `${yt}/watch?v=inv400001` },
    { file: "yt-live-chat-route.html", url: `${yt}/live_chat?v=inv400001`, route: true },
    { file: "yt-live-chat-route.html", url: `${yt}/live_chat_replay?v=inv400001`, route: true },
  ] },
  { feature: "instagram.explore", service: "instagram", pages: [
    { file: "ig-explore.html", url: `${ig}/explore/`, route: true },
    { file: "ig-explore.html", url: `${ig}/explore/tags/inventedtag/`, route: true },
    { file: "ig-explore.html", url: `${ig}/explore/locations/900000001/invented-place/`, route: true },
    { file: "ig-explore.html", url: `${ig}/explore/search/keyword/?q=invented`, route: true },
    { file: "ig-explore.html", url: `${ig}/popular/`, route: true },
    { file: "ig-explore-mobile.html", url: `${ig}/explore/`, route: true },
    { file: "ig-explore-mobile.html", url: `${ig}/explore/search/`, route: true },
    { file: "ig-explore-results.html", url: `${ig}/explore/search/keyword/?q=%23inventedtag`, route: true },
  ] },
  { feature: "instagram.stories", service: "instagram", pages: [
    { file: "ig-stories.html", url: `${ig}/` },
    { file: "ig-stories.html", url: `${ig}/inventeduser1/` },
    { file: "ig-stories.html", url: `${ig}/stories/inventeduser1/900000000001/`, route: true },
    { file: "ig-stories.html", url: `${ig}/stories/highlights/900000000000001/`, route: true },
  ] },
  { feature: "instagram.suggested", service: "instagram", pages: [
    { file: "ig-suggested.html", url: `${ig}/` },
    { file: "ig-suggested.html", url: `${ig}/explore/people/`, route: true },
  ] },
  { feature: "instagram.threads", service: "instagram", pages: [
    { file: "ig-threads.html", url: `${ig}/inventeduser/` },
  ] },
  { feature: "facebook.stories", service: "facebook", pages: [
    { file: "fb-stories.html", url: `${fb}/` },
    { file: "fb-stories.html", url: `${fb}/stories/900000000001/`, route: true },
  ] },
  { feature: "facebook.videos", service: "facebook", pages: [
    { file: "fb-videos.html", url: `${fb}/` },
    { file: "fb-videos.html", url: `${fb}/watch/`, route: true },
    { file: "fb-videos.html", url: `${fb}/watch/?v=900000000105`, route: true },
    { file: "fb-videos.html", url: `${fb}/inventedpage/videos/900000000106`, route: true },
    { file: "fb-videos.html", url: `${fb}/videos/900000000107`, route: true },
  ] },
  { feature: "facebook.sponsored", service: "facebook", pages: [
    { file: "fb-sidebar.html", url: `${fb}/` },
  ] },
];

/** The free feature whose owned class proves the format-2 engine ran on a service's page. */
export const FREE_FEATURE_CLASS: Record<ExtrasService, RegExp> = {
  youtube: /still-feature-\d+-youtube-shorts/,
  instagram: /still-feature-\d+-instagram-reels/,
  facebook: /still-feature-\d+-facebook-reels/,
};

export const SERVICE_ROUTE_GLOB: Record<ExtrasService, string> = {
  youtube: "**://*.youtube.com/**",
  instagram: "**://*.instagram.com/**",
  facebook: "**://*.facebook.com/**",
};

/** Words of the 12 feature ids; no owned class or marker may carry one while paid is off. */
export const EXTRAS_FEATURE_WORDS: readonly string[] = [
  "related", "endscreen", "autoplay", "comments", "livechat",
  "explore", "stories", "suggested", "threads", "videos", "sponsored",
];

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXTRAS_FIXTURE_DIR = resolve(HERE, "../../../../../tests/fixtures/extras");

export function extrasFixture(file: string): string {
  return readFileSync(resolve(EXTRAS_FIXTURE_DIR, file), "utf8");
}

/** Ids starting with `prefix` ("target-" or "keep-") in a fixture's markup. */
export function fixtureIds(html: string, prefix: "target-" | "keep-"): string[] {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
  return ids.filter((id) => id.startsWith(prefix));
}

/** Pro `sites.*` intent paths for every control, as the settings intent router takes them. */
export const EXTRAS_INTENT_PATHS: readonly string[] = EXTRAS_CONTROLS.map((c) => `sites.${c.feature}`);

/** Every distinct fixture file, in table order. */
export function extrasFixtureFiles(): string[] {
  return [...new Set(EXTRAS_CONTROLS.flatMap((c) => c.pages.map((p) => p.file)))];
}
