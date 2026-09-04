import { describe, it, expect, beforeEach } from "vitest";
import seed from "../../../rules/seed.json";
import type { SignedRuleSet, StillSettings, ServiceId } from "@still/shared-types";
import { DEFAULT_SETTINGS, PAID_TIER_ENABLED, SERVICE_IDS } from "@still/shared-types";
import {
  evaluate,
  applyDom,
  applyRemovals,
  renderPlaceholder,
  resolveActiveService,
  isServiceActive,
  isServiceEnabledGlobally,
  ALWAYS_FREE_SURFACE_IDS,
  STILL_PLACEHOLDER_LINE,
} from "../engine.js";

const paidTierIt = it.runIf(PAID_TIER_ENABLED);
const includedAccessIt = it.runIf(!PAID_TIER_ENABLED);
const ruleSet = seed as unknown as SignedRuleSet;
const allOn: StillSettings = DEFAULT_SETTINGS;

function settings(over: Partial<StillSettings> = {}): StillSettings {
  return { ...DEFAULT_SETTINGS, ...over };
}
function servicesWith(off: ServiceId): StillSettings["services"] {
  const s = { youtube: true, instagram: true, tiktok: true, facebook: true };
  s[off] = false;
  return s;
}

describe("resolveActiveService — one contract for evaluate + applyDom (U6)", () => {
  const yt = new URL("https://www.youtube.com/feed/subscriptions");

  it("returns the service when active, null for off/paused/unknown", () => {
    expect(resolveActiveService(ruleSet, allOn, yt)).not.toBeNull();
    expect(resolveActiveService(ruleSet, settings({ globalOn: false }), yt)).toBeNull();
    expect(resolveActiveService(ruleSet, settings({ services: servicesWith("youtube") }), yt)).toBeNull();
    expect(resolveActiveService(ruleSet, allOn, new URL("https://example.com/"))).toBeNull();
  });

  it("evaluate and applyDom agree on validity for the same inputs", () => {
    // Active → evaluate decides (not noop); applyDom is free to act.
    expect(evaluate(ruleSet, allOn, yt).kind).not.toBe("noop");
    // Inactive (service off) → both early-return their own empty shape.
    const off = settings({ services: servicesWith("youtube") });
    expect(evaluate(ruleSet, off, yt).kind).toBe("noop");
    expect(applyDom(ruleSet, off, yt, document)).toEqual({ hidden: 0, removed: 0 });
  });
});

describe("isServiceEnabledGlobally — the URL-free gate the DNR wiring shares (R2)", () => {
  it("true only when BOTH the master switch and the service toggle are on", () => {
    expect(isServiceEnabledGlobally(allOn, "youtube")).toBe(true);
    expect(isServiceEnabledGlobally(settings({ globalOn: false }), "youtube")).toBe(false);
    expect(isServiceEnabledGlobally(settings({ services: servicesWith("youtube") }), "youtube")).toBe(false);
    // Both off at once is still off — the matrix has no surprising diagonal.
    expect(
      isServiceEnabledGlobally(settings({ globalOn: false, services: servicesWith("youtube") }), "youtube"),
    ).toBe(false);
  });

  it("never consults pauses (host-scoped, URL-dependent) — per-URL pausing stays isServiceActive's job", () => {
    const paused = settings({ pauses: ["youtube.com"] });
    // Globally the service is on even with its own eTLD+1 in the pause list (which parseSettings
    // normalizes to [] in production anyway)…
    expect(isServiceEnabledGlobally(paused, "youtube")).toBe(true);
    // …while the URL-aware predicate still honors the pause on a matching URL.
    expect(isServiceActive(paused, "youtube", new URL("https://m.youtube.com/shorts/abc"))).toBe(false);
    expect(isServiceActive(allOn, "youtube", new URL("https://m.youtube.com/shorts/abc"))).toBe(true);
  });
});

describe("evaluate — navigation decisions", () => {
  it("redirects a Shorts URL with an id to the watch page (AE1)", () => {
    const d = evaluate(ruleSet, allOn, new URL("https://www.youtube.com/shorts/abc123"));
    expect(d.kind).toBe("redirect");
    if (d.kind === "redirect") expect(d.url).toBe("https://www.youtube.com/watch?v=abc123");
  });

  it("shows the placeholder for a Shorts URL with no id (AE2)", () => {
    expect(evaluate(ruleSet, allOn, new URL("https://www.youtube.com/shorts/")).kind).toBe("placeholder");
    expect(evaluate(ruleSet, allOn, new URL("https://www.youtube.com/shorts")).kind).toBe("placeholder");
  });

  it("applies (hide/remove) on an ordinary YouTube page", () => {
    expect(evaluate(ruleSet, allOn, new URL("https://www.youtube.com/feed/subscriptions")).kind).toBe("apply");
  });

  it("blocks the whole site on TikTok — marked as blocked (not merely cleared)", () => {
    const a = evaluate(ruleSet, allOn, new URL("https://www.tiktok.com/foryou"));
    const b = evaluate(ruleSet, allOn, new URL("https://www.tiktok.com/@someone"));
    const c = evaluate(ruleSet, allOn, new URL("https://m.tiktok.com/"));
    expect(a).toEqual({ kind: "placeholder", blocked: true });
    expect(b.kind).toBe("placeholder");
    expect(b).toMatchObject({ blocked: true });
    expect(c).toMatchObject({ kind: "placeholder", blocked: true });
  });

  it("placeholders direct Instagram Reels URLs (cleared, not a whole-site block)", () => {
    const d = evaluate(ruleSet, allOn, new URL("https://www.instagram.com/reel/XYZ/"));
    expect(d.kind).toBe("placeholder");
    expect(d).not.toMatchObject({ blocked: true }); // a cleared URL, not a site block
    expect(evaluate(ruleSet, allOn, new URL("https://www.instagram.com/reels/")).kind).toBe("placeholder");
    expect(evaluate(ruleSet, allOn, new URL("https://www.instagram.com/someuser/reels/")).kind).toBe("placeholder");
    // Instagram serves the same Reel at two addresses. The root one was blocked and the profile one
    // was not, so a Reel opened from a profile or a shared link still played.
    expect(evaluate(ruleSet, allOn, new URL("https://www.instagram.com/someuser/reel/XYZ/")).kind).toBe("placeholder");
    // An ordinary profile, and a username that merely begins with the letters "reel", are not Reels.
    expect(evaluate(ruleSet, allOn, new URL("https://www.instagram.com/someuser/")).kind).toBe("apply");
    expect(evaluate(ruleSet, allOn, new URL("https://www.instagram.com/reelmaker/")).kind).toBe("apply");
  });

  it("placeholders a direct Facebook Reel URL", () => {
    expect(evaluate(ruleSet, allOn, new URL("https://www.facebook.com/reel/123")).kind).toBe("placeholder");
    expect(evaluate(ruleSet, allOn, new URL("https://m.facebook.com/reels/")).kind).toBe("placeholder");
    expect(evaluate(ruleSet, allOn, new URL("https://m.facebook.com/watch/reels/")).kind).toBe("placeholder");
    // A Page's own Reels tab, which is where the hidden tab used to lead.
    expect(evaluate(ruleSet, allOn, new URL("https://www.facebook.com/somepage/reels/")).kind).toBe("placeholder");
    // A Page's ordinary sections are long-form video and photos, which Still leaves alone.
    expect(evaluate(ruleSet, allOn, new URL("https://www.facebook.com/somepage/videos")).kind).toBe("apply");
    expect(evaluate(ruleSet, allOn, new URL("https://www.facebook.com/somepage/")).kind).toBe("apply");
    expect(evaluate(ruleSet, allOn, new URL("https://www.facebook.com/reelestate/")).kind).toBe("apply");
  });

  it("leaves Facebook's own sections alone when their address ends in the word reels", () => {
    // "/<name>/reels" is a Page's Reels tab only when <name> is a Page. Facebook reserves its own
    // first path segment for sections like groups and hashtag, so /groups/reels is a real group
    // about fishing rods, reels and tackle, and /hashtag/reels is the hashtag feed. Both render
    // ordinary content and neither is short-form video, so Still must not cover them.
    for (const path of [
      "/groups/reels",
      "/groups/reels/",
      "/hashtag/reels",
      "/marketplace/reels",
      "/gaming/reels",
      "/games/reels",
      "/live/reels",
      "/events/reels",
      "/pages/reels",
      "/people/reels",
      "/stories/reels",
      "/search/reels",
      "/help/reels",
      "/business/reels",
      "/settings/reels",
      "/messages/reels",
      "/notifications/reels",
      "/bookmarks/reels",
      "/friends/reels",
      "/saved/reels",
      "/ads/reels",
      "/photo/reels",
      "/policies/reels",
      "/legal/reels",
      "/careers/reels",
      "/login/reels",
      "/privacy/reels",
    ]) {
      expect(evaluate(ruleSet, allOn, new URL(`https://www.facebook.com${path}`)).kind).toBe("apply");
      expect(evaluate(ruleSet, allOn, new URL(`https://m.facebook.com${path}`)).kind).toBe("apply");
    }

    // Narrowing must not give back the Reels addresses this rule exists to cover: a Page whose
    // vanity name merely begins with a section name is still a Page.
    for (const path of [
      "/reel/123",
      "/reels/",
      "/watch/reels/",
      "/somepage/reels",
      "/somepage/reels/",
      "/100064860875397/reels",
      "/groupsofpeople/reels",
      "/liveband/reels",
    ]) {
      expect(evaluate(ruleSet, allOn, new URL(`https://www.facebook.com${path}`)).kind).toBe(
        "placeholder",
      );
    }
  });

  it("is a no-op on an unknown domain", () => {
    expect(evaluate(ruleSet, allOn, new URL("https://example.com/")).kind).toBe("noop");
  });

  it("is a no-op when globalOn is false", () => {
    expect(evaluate(ruleSet, settings({ globalOn: false }), new URL("https://www.tiktok.com/")).kind).toBe("noop");
  });

  it("is a no-op when the current host is paused (AE5)", () => {
    const paused = settings({ pauses: ["youtube.com"] });
    expect(evaluate(ruleSet, paused, new URL("https://m.youtube.com/shorts/abc")).kind).toBe("noop");
  });
});

describe("evaluate — per-service toggle matrix (KTD7)", () => {
  const probe: Record<ServiceId, URL> = {
    youtube: new URL("https://www.youtube.com/shorts/abc"),
    instagram: new URL("https://www.instagram.com/reel/x/"),
    tiktok: new URL("https://www.tiktok.com/foryou"),
    facebook: new URL("https://www.facebook.com/reel/1"),
  };

  for (const id of SERVICE_IDS) {
    it(`acts on ${id} when on, no-ops when its toggle is off`, () => {
      expect(evaluate(ruleSet, allOn, probe[id]).kind).not.toBe("noop");
      const off = settings({ services: servicesWith(id) });
      expect(evaluate(ruleSet, off, probe[id]).kind).toBe("noop");
    });
  }
});

describe("evaluate — safety model (AE4)", () => {
  it("keeps a brand-new service off until the user enables it", () => {
    const extended = JSON.parse(JSON.stringify(ruleSet));
    extended.services.snapchat = {
      matches: ["*://*.snapchat.com/*"],
      surfaces: [{ id: "sc", label: "all", action: "blockSite", enabledByDefault: true }],
    };
    // settings has no 'snapchat' key → resolves off
    expect(evaluate(extended as SignedRuleSet, allOn, new URL("https://www.snapchat.com/")).kind).toBe("noop");
  });

  it("applies a newly-added surface under an already-enabled service immediately", () => {
    const extended = JSON.parse(JSON.stringify(ruleSet));
    extended.services.youtube.surfaces.push({
      id: "yt-new", label: "new shelf", action: "remove", enabledByDefault: true, selectors: ["div.new-shorts"],
    });
    document.body.innerHTML = `<div class="new-shorts" id="n"></div>`;
    applyDom(extended as SignedRuleSet, allOn, new URL("https://www.youtube.com/"), document);
    expect(document.querySelector("#n")).toBeNull();
  });

  paidTierIt("defaults a newly-added unlabeled surface to Pro for free users", () => {
    const extended = JSON.parse(JSON.stringify(ruleSet));
    extended.services.youtube.surfaces.push({
      id: "yt-new-premium",
      label: "new premium shelf",
      action: "remove",
      enabledByDefault: true,
      selectors: ["div.new-premium"],
    });
    document.body.innerHTML = `<div class="new-premium" id="n"></div>`;
    applyDom(extended as SignedRuleSet, allOn, new URL("https://www.youtube.com/"), document, { pro: false });
    expect(document.querySelector("#n")).not.toBeNull();
    applyDom(extended as SignedRuleSet, allOn, new URL("https://www.youtube.com/"), document, { pro: true });
    expect(document.querySelector("#n")).toBeNull();
  });
});

describe("evaluate/applyDom — monetization gating", () => {
  includedAccessIt("applies every enabled service without entitlement while the paid tier is off", () => {
    expect(PAID_TIER_ENABLED).toBe(false);
    expect(evaluate(ruleSet, allOn, new URL("https://www.instagram.com/reel/XYZ/"), { pro: false }).kind).toBe("placeholder");
    expect(evaluate(ruleSet, allOn, new URL("https://www.tiktok.com/foryou"), { pro: false })).toMatchObject({
      kind: "placeholder",
      blocked: true,
    });
    expect(evaluate(ruleSet, allOn, new URL("https://www.facebook.com/reel/123"), { pro: false }).kind).toBe("placeholder");
  });

  it("keeps every current YouTube Shorts surface free", () => {
    const yt = ruleSet.services.youtube!.surfaces;
    // Containment, not exact set-equality: every always-free safety-net id must exist in the seed
    // tagged tier:"free". Exact equality would falsely fail the day a *Pro* YouTube surface ships —
    // and a new Pro YouTube surface must NOT be added to ALWAYS_FREE_SURFACE_IDS.
    for (const id of ALWAYS_FREE_SURFACE_IDS) {
      const surface = yt.find((s) => s.id === id);
      expect(surface, `${id} should be a seed YouTube surface`).toBeDefined();
      expect(surface!.tier).toBe("free");
    }
  });

  it("keeps YouTube Shorts redirect free even when Pro is false", () => {
    const d = evaluate(ruleSet, allOn, new URL("https://www.youtube.com/shorts/abc123"), { pro: false });
    expect(d.kind).toBe("redirect");
  });

  it("keeps YouTube Shorts DOM removal free even when Pro is false", () => {
    document.body.innerHTML = `<ytd-reel-shelf-renderer id="shelf"></ytd-reel-shelf-renderer>`;
    applyDom(ruleSet, allOn, new URL("https://www.youtube.com/"), document, { pro: false });
    expect(document.querySelector("#shelf")).toBeNull();
  });

  it("removes mobile YouTube Shorts tiles and sections while keeping normal mobile videos", () => {
    // Card markup mirrors m.youtube.com: the thumbnail anchor is what says whether a card is a
    // Short, so the fixture carries it rather than a bare link.
    document.body.innerHTML = `
      <ytm-rich-section-renderer id="mobile-shelf">
        <ytm-shorts-lockup-view-model><a href="/shorts/abc">Short</a></ytm-shorts-lockup-view-model>
      </ytm-rich-section-renderer>
      <ytm-video-with-context-renderer id="mobile-short">
        <ytm-media-item class="big-shorts-singleton">
          <a class="media-item-thumbnail-container" href="/shorts/def">Short result</a>
        </ytm-media-item>
      </ytm-video-with-context-renderer>
      <ytm-video-with-context-renderer id="mobile-video">
        <ytm-media-item><a class="media-item-thumbnail-container" href="/watch?v=long">Long result</a></ytm-media-item>
      </ytm-video-with-context-renderer>
    `;

    applyDom(ruleSet, allOn, new URL("https://m.youtube.com/results?search_query=shorts"), document, { pro: false });

    expect(document.querySelector("#mobile-shelf")).toBeNull();
    expect(document.querySelector("#mobile-short")).toBeNull();
    expect(document.querySelector("#mobile-video")).not.toBeNull();
  });

  paidTierIt("does not apply Pro services for free users", () => {
    expect(evaluate(ruleSet, allOn, new URL("https://www.instagram.com/reel/XYZ/"), { pro: false }).kind).toBe("noop");
    expect(evaluate(ruleSet, allOn, new URL("https://www.tiktok.com/foryou"), { pro: false }).kind).toBe("noop");
    expect(evaluate(ruleSet, allOn, new URL("https://www.facebook.com/reel/123"), { pro: false }).kind).toBe("noop");
  });

  it("applies real seed Pro surfaces when pro=true", () => {
    expect(evaluate(ruleSet, allOn, new URL("https://www.instagram.com/reel/XYZ/"), { pro: true }).kind).toBe("placeholder");
    expect(evaluate(ruleSet, allOn, new URL("https://www.tiktok.com/foryou"), { pro: true })).toMatchObject({
      kind: "placeholder",
      blocked: true,
    });
    expect(evaluate(ruleSet, allOn, new URL("https://www.facebook.com/reel/123"), { pro: true }).kind).toBe("placeholder");
  });

  paidTierIt("gates every non-free surface on the single pro flag (no second gating axis)", () => {
    // requiredCapability tags in the seed are reserved authored data — the engine must ignore them
    // and gate purely by tier + pro, so tier and capability data can never silently disagree.
    expect(evaluate(ruleSet, allOn, new URL("https://www.instagram.com/reel/XYZ/"), { pro: false }).kind).toBe("noop");
    expect(evaluate(ruleSet, allOn, new URL("https://www.tiktok.com/foryou"), { pro: false }).kind).toBe("noop");
    expect(evaluate(ruleSet, allOn, new URL("https://www.instagram.com/reel/XYZ/"), { pro: true }).kind).toBe("placeholder");
  });

  it("applyRemovals runs only remove surfaces — hide is left to the packaged manifest CSS", () => {
    document.body.innerHTML =
      `<a id="hideme" title="Shorts">Shorts</a>` + // yt-sidebar/chips style hide target
      `<ytd-reel-shelf-renderer id="removeme"></ytd-reel-shelf-renderer>`; // remove target (yt-home-shelf)
    const result = applyRemovals(ruleSet, allOn, new URL("https://www.youtube.com/"), document, { pro: false });
    expect(result.hidden).toBe(0);
    expect((document.querySelector("#hideme") as HTMLElement | null)?.style.display).not.toBe("none");
    expect(document.querySelector("#removeme")).toBeNull(); // ytd-reel-shelf-renderer removed
    expect(result.removed).toBeGreaterThan(0);
  });

  it("treats current YouTube Shorts surfaces as free even if tags are missing", () => {
    const untagged = JSON.parse(JSON.stringify(ruleSet));
    for (const surface of untagged.services.youtube.surfaces) delete surface.tier;
    document.body.innerHTML = `<a id="endpoint" title="Shorts">Shorts</a>`;
    applyDom(untagged as SignedRuleSet, allOn, new URL("https://www.youtube.com/"), document, { pro: false });
    expect((document.querySelector("#endpoint") as HTMLElement).style.display).toBe("none");
    expect(evaluate(untagged as SignedRuleSet, allOn, new URL("https://www.youtube.com/shorts/abc"), { pro: false }).kind).toBe("redirect");
  });
});

describe("applyDom", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.className = "";
  });

  it("removes a YouTube reel shelf but leaves other content", () => {
    document.body.innerHTML = `
      <ytd-reel-shelf-renderer id="shelf"></ytd-reel-shelf-renderer>
      <div id="keep">a real video</div>`;
    const res = applyDom(ruleSet, allOn, new URL("https://www.youtube.com/"), document);
    expect(document.querySelector("#shelf")).toBeNull();
    expect(document.querySelector("#keep")).not.toBeNull();
    expect(res.removed).toBeGreaterThan(0);
  });

  it("hides (not removes) the Shorts sidebar entry via display:none", () => {
    document.body.innerHTML = `<a id="endpoint" title="Shorts">Shorts</a>`;
    applyDom(ruleSet, allOn, new URL("https://www.youtube.com/"), document);
    const el = document.querySelector("#endpoint") as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el!.style.display).toBe("none");
  });

  it("hides the mobile Shorts pivot item by its mobile class", () => {
    document.body.innerHTML = `
      <ytm-pivot-bar-item-renderer id="shorts-tab"><div class="pivot-bar-item-tab pivot-shorts">Shorts</div></ytm-pivot-bar-item-renderer>
      <ytm-pivot-bar-item-renderer id="home-tab"><div class="pivot-bar-item-tab pivot-w2w">Home</div></ytm-pivot-bar-item-renderer>
    `;
    applyDom(ruleSet, allOn, new URL("https://m.youtube.com/"), document);
    expect((document.querySelector("#shorts-tab") as HTMLElement).style.display).toBe("none");
    expect((document.querySelector("#home-tab") as HTMLElement).style.display).toBe("");
  });

  it("removes mobile Instagram Reels surfaces while keeping normal mobile posts", () => {
    document.body.innerHTML = `
      <nav>
        <a id="ig-reels-nav" href="/reels/" aria-label="Reels">Reels</a>
        <a id="ig-home-nav" href="/">Home</a>
      </nav>
      <main>
        <article id="ig-reel"><a href="/reel/abc">a reel</a></article>
        <article id="ig-post"><a href="/p/photo">a photo</a></article>
      </main>
    `;
    applyDom(ruleSet, allOn, new URL("https://www.instagram.com/"), document, { pro: true });
    expect(document.querySelector("#ig-reel")).toBeNull();
    expect(document.querySelector("#ig-post")).not.toBeNull();
    expect((document.querySelector("#ig-reels-nav") as HTMLElement).style.display).toBe("none");
    expect((document.querySelector("#ig-home-nav") as HTMLElement).style.display).toBe("");
  });

  it("removes mobile Facebook Reels surfaces while keeping normal mobile feed posts", () => {
    document.body.innerHTML = `
      <nav>
        <a id="fb-reels-nav" href="/reels/" aria-label="Reels">Reels</a>
        <div role="tablist">
          <div id="fb-mobile-reels-tab" role="tab" aria-label="reels, 4 of 6"><div id="fb-reels-icon">0</div></div>
          <div id="fb-mobile-home-tab" role="tab" aria-label="home, 1 of 6"><div id="fb-home-icon">915+</div></div>
        </div>
        <a id="fb-home-nav" href="/">Home</a>
      </nav>
      <main role="feed">
        <div role="article" id="fb-reel"><a href="/reels/abc">a reel</a></div>
        <div id="fb-reel-button" role="button" aria-label="View reel video from Wally with 127 thousand views ."></div>
        <div role="article" id="fb-post"><a href="/story.php?story_fbid=1">a status</a></div>
      </main>
    `;
    applyDom(ruleSet, allOn, new URL("https://m.facebook.com/"), document, { pro: true });
    expect(document.querySelector("#fb-reel")).toBeNull();
    expect(document.querySelector("#fb-post")).not.toBeNull();
    expect((document.querySelector("#fb-reels-nav") as HTMLElement).style.display).toBe("none");
    // Issue #58 semantics: the tab BOX must survive as its own white (bg-s2) cover for the slot —
    // Facebook pins every tab to precomputed offsets and never reflows siblings, so removing the
    // tab exposes the ancestor's gray background through the hole. Only its CONTENTS hide.
    expect(document.querySelector("#fb-mobile-reels-tab")).not.toBeNull();
    expect((document.querySelector("#fb-reels-icon") as HTMLElement).style.display).toBe("none");
    expect((document.querySelector("#fb-mobile-home-tab") as HTMLElement).style.display).toBe("");
    expect((document.querySelector("#fb-home-icon") as HTMLElement).style.display).toBe("");
    expect(document.querySelector("#fb-reel-button")).toBeNull();
    expect((document.querySelector("#fb-home-nav") as HTMLElement).style.display).toBe("");
  });

  // Issue #58 (second round, from live Web Inspector DOM): every tab is pinned to its slot with
  // precomputed inline offsets (width:67px; margin-left:…) — siblings never reflow, so ANY removal
  // (tab or wrapper) leaves a hole exposing the ancestor's gray bg-s26. The fix keeps the tab as
  // its own bg-s2 (white) cover and hides only its children. Modeled on the real MContainer shape.
  it("keeps the pinned Reels tab as a blank cover — children hidden, box and siblings intact (issue #58)", () => {
    document.body.innerHTML = `
      <div role="tablist" style="height:50px">
        <div id="tab-feed" role="tab" aria-label="feed, 1 of 6" class="m bg-s2"><div id="feed-icon"></div></div>
        <div id="tab-reels" role="tab" aria-label="reels, 4 of 6" class="m bg-s2"><div id="reels-icon"></div><div id="reels-badge">3</div></div>
        <div id="tab-market" role="tab" aria-label="marketplace, 1 new, 6 of 6" class="m bg-s2"><div id="market-icon"></div></div>
      </div>
    `;
    applyDom(ruleSet, allOn, new URL("https://m.facebook.com/"), document, { pro: true });
    // The tab box survives (it IS the slot's white cover) and stays in flow…
    const reelsTab = document.querySelector("#tab-reels") as HTMLElement;
    expect(reelsTab).not.toBeNull();
    expect(reelsTab.style.display).toBe("");
    // …while everything inside it disappears.
    expect((document.querySelector("#reels-icon") as HTMLElement).style.display).toBe("none");
    expect((document.querySelector("#reels-badge") as HTMLElement).style.display).toBe("none");
    // Sibling tabs and their contents are untouched.
    expect((document.querySelector("#feed-icon") as HTMLElement).style.display).toBe("");
    expect((document.querySelector("#market-icon") as HTMLElement).style.display).toBe("");
    expect(document.querySelectorAll("[role=tablist] > *").length).toBe(3);
  });

  paidTierIt("leaves every Facebook mobile tab-bar surface intact for a FREE user (monetization gate)", () => {
    document.body.innerHTML = `
      <div role="tablist">
        <div id="free-reels-tab" role="tab" aria-label="reels, 4 of 6"><div id="free-reels-icon"></div></div>
      </div>
      <div id="free-reel-button" role="button" aria-label="View reel video from Wally ."></div>
    `;
    applyDom(ruleSet, allOn, new URL("https://m.facebook.com/"), document, { pro: false });
    expect(document.querySelector("#free-reels-tab")).not.toBeNull();
    expect((document.querySelector("#free-reels-icon") as HTMLElement).style.display).toBe("");
    expect(document.querySelector("#free-reel-button")).not.toBeNull();
  });

  it("does nothing when the service is off", () => {
    document.body.innerHTML = `<ytd-reel-shelf-renderer id="shelf"></ytd-reel-shelf-renderer>`;
    applyDom(ruleSet, settings({ services: servicesWith("youtube") }), new URL("https://www.youtube.com/"), document);
    expect(document.querySelector("#shelf")).not.toBeNull();
  });
});

describe("renderPlaceholder", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="page">feed</div>`;
  });

  it("replaces the body with the placeholder once", () => {
    renderPlaceholder(document);
    const root = document.getElementById("still-placeholder");
    expect(root).not.toBeNull();
    expect(document.getElementById("page")).toBeNull();
    expect(root?.querySelector("p")?.textContent).toBe(STILL_PLACEHOLDER_LINE);
  });

  it("no-ops when the placeholder is already up (observer-loop guard)", () => {
    renderPlaceholder(document);
    const first = document.getElementById("still-placeholder");
    renderPlaceholder(document);
    // Same node, not a fresh replaceChildren — a re-render would re-trigger the reapply observer.
    expect(document.getElementById("still-placeholder")).toBe(first);
    expect(document.body.childElementCount).toBe(1);
  });

  it("updates the copy in place when the line changes", () => {
    renderPlaceholder(document, "one");
    const first = document.getElementById("still-placeholder");
    renderPlaceholder(document, "two");
    expect(document.getElementById("still-placeholder")).toBe(first);
    expect(first?.querySelector("p")?.textContent).toBe("two");
  });
});

// Every case below is taken from a signed-out capture of the live site. The rule is one sentence:
// a card is a Short when its OWN thumbnail is a Short, and a shelf is a Shorts shelf when it holds
// Shorts lockups. "Contains a link to a Short somewhere" is not the test, because ordinary cards
// and mixed sections routinely contain one.
describe("applyRemovals — YouTube Shorts surfaces against live markup", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.className = "";
  });

  const sweep = (href: string) =>
    applyRemovals(ruleSet, allOn, new URL(href), document, { pro: false });

  it("removes the search Shorts shelf whole, heading and all", () => {
    document.body.innerHTML = `
      <grid-shelf-view-model id="shelf">
        <yt-shelf-header-layout><h2>Shorts</h2><button>Show more</button></yt-shelf-header-layout>
        <ytm-shorts-lockup-view-model><a href="/shorts/abc">a short</a></ytm-shorts-lockup-view-model>
      </grid-shelf-view-model>
      <grid-shelf-view-model id="keep-shelf">
        <yt-shelf-header-layout><h2>For you</h2></yt-shelf-header-layout>
        <yt-lockup-view-model><a href="/watch?v=long">a long-form video</a></yt-lockup-view-model>
      </grid-shelf-view-model>`;
    sweep("https://www.youtube.com/results?search_query=shorts");
    expect(document.querySelector("#shelf")).toBeNull();
    expect(document.querySelector("#keep-shelf")).not.toBeNull();
  });

  it("removes a mobile card whose own thumbnail is a Short", () => {
    document.body.innerHTML = `
      <ytm-video-with-context-renderer id="short">
        <ytm-media-item class="big-shorts-singleton">
          <a class="media-item-thumbnail-container" href="/shorts/abc">a short</a>
        </ytm-media-item>
      </ytm-video-with-context-renderer>`;
    sweep("https://m.youtube.com/results?search_query=shorts");
    expect(document.querySelector("#short")).toBeNull();
  });

  it("keeps a mobile card that merely links to a Short from its channel row", () => {
    document.body.innerHTML = `
      <ytm-video-with-context-renderer id="keep">
        <ytm-media-item>
          <a class="media-item-thumbnail-container" href="/watch?v=long">a long-form video</a>
          <div class="media-channel"><a class="media-item-extra-endpoint" href="/shorts/abc">a short</a></div>
        </ytm-media-item>
      </ytm-video-with-context-renderer>`;
    sweep("https://m.youtube.com/results?search_query=news");
    expect(document.querySelector("#keep")).not.toBeNull();
  });

  it("keeps a mobile home section that is not a Shorts shelf", () => {
    document.body.innerHTML = `
      <ytm-rich-section-renderer id="shorts-section">
        <ytm-shorts-lockup-view-model><a href="/shorts/abc">a short</a></ytm-shorts-lockup-view-model>
      </ytm-rich-section-renderer>
      <ytm-rich-section-renderer id="keep-section">
        <yt-lockup-view-model>
          <a href="/watch?v=long">a long-form video</a>
          <div class="blurb">see also <a href="/shorts/def">my short</a></div>
        </yt-lockup-view-model>
      </ytm-rich-section-renderer>`;
    sweep("https://m.youtube.com/");
    expect(document.querySelector("#shorts-section")).toBeNull();
    expect(document.querySelector("#keep-section")).not.toBeNull();
  });

  it("keeps a desktop search result that only mentions a Short in its description", () => {
    document.body.innerHTML = `
      <ytd-video-renderer id="short">
        <ytd-thumbnail><a id="thumbnail" href="/shorts/abc">a short</a></ytd-thumbnail>
      </ytd-video-renderer>
      <ytd-video-renderer id="keep">
        <ytd-thumbnail><a id="thumbnail" href="/watch?v=long">a long-form video</a></ytd-thumbnail>
        <div id="description"><a href="/shorts/def">watch the short version</a></div>
      </ytd-video-renderer>`;
    sweep("https://www.youtube.com/results?search_query=news");
    expect(document.querySelector("#short")).toBeNull();
    expect(document.querySelector("#keep")).not.toBeNull();
  });

  it("leaves a Shorts URL written into a community post, which the redirect handles instead", () => {
    document.body.innerHTML = `
      <ytd-post-renderer id="post">
        <div id="post-text"><a href="/shorts/abc">https://www.youtube.com/shorts/abc</a></div>
      </ytd-post-renderer>`;
    sweep("https://www.youtube.com/@YouTube");
    expect(document.querySelector("#post")).not.toBeNull();
    expect(evaluate(ruleSet, allOn, new URL("https://www.youtube.com/shorts/abc"))).toEqual({
      kind: "redirect",
      url: "https://www.youtube.com/watch?v=abc",
    });
  });
});

// The sweep runs on every mutation frame of an infinite feed, so it queries the document once per
// action rather than once per selector. Two behaviours follow, and both are load bearing.
describe("applyRemovals — one query per action", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.className = "";
  });

  it("walks the document once per action, not once per selector", () => {
    const calls: string[] = [];
    const original = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function (this: Document, selector: string) {
      calls.push(selector);
      return original.call(this, selector) as never;
    } as typeof original;
    try {
      applyRemovals(ruleSet, allOn, new URL("https://m.youtube.com/"), document, { pro: false });
    } finally {
      Document.prototype.querySelectorAll = original;
    }
    expect(calls).toHaveLength(1);
    // The one query carries every distinct remove selector of the active service, deduplicated
    // across surfaces that share a shelf.
    const youtube = ruleSet.services.youtube!;
    const authored = new Set(
      youtube.surfaces
        .filter((s) => s.action === "remove" && s.selectors)
        .flatMap((s) => [...s.selectors!]),
    );
    expect(calls[0]!.split(",")).toHaveLength(authored.size);
  });

  it("removes a wrapper and its contents whatever order the selectors are authored in", () => {
    // Authored inner-first, which used to leave the wrapper behind as an empty box because the
    // wrapper's :has() test named a child an earlier selector had already removed.
    const innerFirst: SignedRuleSet = {
      ...ruleSet,
      services: {
        youtube: {
          matches: ["*://*.youtube.com/*"],
          surfaces: [
            {
              id: "yt-home-shelf",
              label: "test",
              tier: "free",
              action: "remove",
              enabledByDefault: true,
              selectors: ["ytm-reel-shelf-renderer", "ytm-rich-section-renderer:has(ytm-reel-shelf-renderer)"],
            },
          ],
        },
      },
    };
    document.body.innerHTML = `
      <ytm-rich-section-renderer id="section">
        <ytm-reel-shelf-renderer id="shelf"></ytm-reel-shelf-renderer>
      </ytm-rich-section-renderer>`;
    applyRemovals(innerFirst, allOn, new URL("https://m.youtube.com/"), document, { pro: false });
    expect(document.querySelector("#section")).toBeNull();
  });

  it("falls back to one query per selector when the browser rejects the list", () => {
    const withUnsupported: SignedRuleSet = {
      ...ruleSet,
      services: {
        youtube: {
          matches: ["*://*.youtube.com/*"],
          surfaces: [
            {
              id: "yt-home-shelf",
              label: "test",
              tier: "free",
              action: "remove",
              enabledByDefault: true,
              // A selector this engine cannot parse must not cost us the one beside it.
              selectors: ["ytd-reel-shelf-renderer:unsupported-by-this-browser", "ytd-reel-shelf-renderer"],
            },
          ],
        },
      },
    };
    document.body.innerHTML = `<ytd-reel-shelf-renderer id="shelf"></ytd-reel-shelf-renderer>`;
    const res = applyRemovals(withUnsupported, allOn, new URL("https://www.youtube.com/"), document, { pro: false });
    expect(document.querySelector("#shelf")).toBeNull();
    expect(res.removed).toBe(1);
  });
});
