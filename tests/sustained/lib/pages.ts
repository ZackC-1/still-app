// The five ordinary pages of the sustained session, each a hand-written fixture from
// tests/fixtures served at its real address (no network). One tab per page stays open for the
// whole session, the way someone keeps a few sites open over a day.
//
// The plan names "five ordinary pages" without listing them. The first four are the four
// supported services; the fifth is the YouTube watch page, the page the plan's own long
// observation (five watch pages over a day) is about. That choice is a coordinator question.
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
  tiktok?: boolean;
}

export const SESSION_PAGES: readonly SessionPage[] = [
  {
    key: "youtube-home",
    serviceSwitch: "Still on YouTube",
    url: "https://www.youtube.com/feed/subscriptions",
    fixture: "youtube.html",
    routes: ["/feed/trending", "/"],
    target: "#subs-shorts-shelf",
    keep: "#keep-subs-video",
  },
  {
    key: "youtube-watch",
    serviceSwitch: "Still on YouTube",
    url: "https://www.youtube.com/watch?v=long123",
    fixture: "youtube-watch.html",
    routes: ["/watch?v=next456", "/watch?v=other789"],
    target: "#watch-shorts-shelf",
    keep: "#keep-player",
  },
  {
    key: "instagram-home",
    serviceSwitch: "Still on Instagram",
    url: "https://www.instagram.com/",
    fixture: "instagram-home.html",
    routes: ["/p/sustained1/", "/someuser/"],
    target: "#reel-post",
    keep: "#keep-photo-post",
  },
  {
    key: "facebook-home",
    serviceSwitch: "Still on Facebook",
    url: "https://www.facebook.com/",
    fixture: "facebook.html",
    routes: ["/groups/feed/", "/marketplace/"],
    target: "#reels-shortcut",
    keep: "#keep-menu-home",
  },
  {
    key: "tiktok-allowed",
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
