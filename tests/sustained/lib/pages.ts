// The five ordinary pages of the sustained session, each a hand-written fixture from
// tests/fixtures served at its real address (no network). One tab per page stays open for the
// whole session, the way someone keeps a few sites open over a day.
//
// The plan names "five ordinary pages" without listing them. The first four are the four
// supported services; the fifth is the YouTube watch page, the page the plan's own long
// observation (five watch pages over a day) is about (coordinator ruling, 2026-10-05).
//
// Off is zero work on format-2 pages (coordinator ruling, 2026-10-05): with Still or the site off
// and the feed still growing, those pages must see no DOM writes and no content-script callbacks.
// The allowed TikTok tab runs the legacy engine, whose observer keeps watching while off by
// design, so it is exempt.
export interface SessionPage {
  key: string;
  /** The options-page switch that turns this page's service off. */
  serviceSwitch: string;
  url: string;
  fixture: string;
  /** Same-document routes the session moves between (history.pushState). */
  routes: readonly string[];
  /** A fixture element Still hides while on; null where the page is an allowed TikTok tab. */
  target: string | null;
  /** An ordinary element that must stay visible. */
  keep: string;
  /** Which content engine runs here: format-2 hides with a stylesheet; legacy observes the DOM. */
  engine: "format2" | "legacy";
  tiktok?: boolean;
}

export const SESSION_PAGES: readonly SessionPage[] = [
  {
    key: "youtube-home",
    engine: "format2",
    serviceSwitch: "Still on YouTube",
    url: "https://www.youtube.com/feed/subscriptions",
    fixture: "youtube.html",
    routes: ["/feed/trending", "/"],
    target: "#subs-shorts-shelf",
    keep: "#keep-subs-video",
  },
  {
    key: "youtube-watch",
    engine: "format2",
    serviceSwitch: "Still on YouTube",
    url: "https://www.youtube.com/watch?v=long123",
    fixture: "youtube-watch.html",
    routes: ["/watch?v=next456", "/watch?v=other789"],
    target: "#watch-shorts-shelf",
    keep: "#keep-player",
  },
  {
    key: "instagram-home",
    engine: "format2",
    serviceSwitch: "Still on Instagram",
    url: "https://www.instagram.com/",
    fixture: "instagram-home.html",
    routes: ["/p/sustained1/", "/someuser/"],
    target: "#reel-post",
    keep: "#keep-photo-post",
  },
  {
    key: "facebook-home",
    engine: "format2",
    serviceSwitch: "Still on Facebook",
    url: "https://www.facebook.com/",
    fixture: "facebook.html",
    routes: ["/groups/feed/", "/marketplace/"],
    target: "#reels-shortcut",
    keep: "#keep-menu-home",
  },
  {
    key: "tiktok-allowed",
    engine: "legacy",
    serviceSwitch: "TikTok website",
    url: "https://www.tiktok.com/foryou",
    fixture: "tiktok.html",
    routes: ["/following", "/foryou"],
    target: null,
    keep: "#tiktok-feed",
    tiktok: true,
  },
];

/** Which fixture answers a request: by host, and on www.youtube.com by path. */
export function fixtureFor(url: URL): string | null {
  const host = url.hostname;
  if (host.endsWith("youtube.com")) return url.pathname.startsWith("/watch") ? "youtube-watch.html" : "youtube.html";
  if (host.endsWith("instagram.com")) return "instagram-home.html";
  if (host.endsWith("facebook.com")) return "facebook.html";
  if (host.endsWith("tiktok.com")) return "tiktok.html";
  return null;
}
