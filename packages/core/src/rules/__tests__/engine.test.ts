import { describe, it, expect, beforeEach } from "vitest";
import seed from "../../../rules/seed.json";
import type { SignedRuleSet, StillSettings, ServiceId } from "@still/shared-types";
import { DEFAULT_SETTINGS, SERVICE_IDS } from "@still/shared-types";
import {
  evaluate,
  applyDom,
  generateHideCss,
  ROOT_ACTIVE_CLASS,
  resolveActiveService,
  ALWAYS_FREE_SURFACE_IDS,
} from "../engine.js";

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
    expect(a).toEqual({ kind: "placeholder", blocked: true });
    expect(b.kind).toBe("placeholder");
    expect(b).toMatchObject({ blocked: true });
  });

  it("placeholders direct Instagram Reels URLs (cleared, not a whole-site block)", () => {
    const d = evaluate(ruleSet, allOn, new URL("https://www.instagram.com/reel/XYZ/"));
    expect(d.kind).toBe("placeholder");
    expect(d).not.toMatchObject({ blocked: true }); // a cleared URL, not a site block
    expect(evaluate(ruleSet, allOn, new URL("https://www.instagram.com/reels/")).kind).toBe("placeholder");
  });

  it("placeholders a direct Facebook Reel URL", () => {
    expect(evaluate(ruleSet, allOn, new URL("https://www.facebook.com/reel/123")).kind).toBe("placeholder");
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

  it("defaults a newly-added unlabeled surface to Pro for free users", () => {
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
  it("keeps every current YouTube Shorts surface free", () => {
    const yt = ruleSet.services.youtube!.surfaces;
    expect(yt.map((s) => s.id).sort()).toEqual([...ALWAYS_FREE_SURFACE_IDS].sort());
    expect(yt.every((s) => s.tier === "free")).toBe(true);
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

  it("does not apply Pro services for free users", () => {
    expect(evaluate(ruleSet, allOn, new URL("https://www.instagram.com/reel/XYZ/"), { pro: false }).kind).toBe("noop");
    expect(evaluate(ruleSet, allOn, new URL("https://www.tiktok.com/foryou"), { pro: false }).kind).toBe("noop");
    expect(evaluate(ruleSet, allOn, new URL("https://www.facebook.com/reel/123"), { pro: false }).kind).toBe("noop");
  });

  it("can gate premium surfaces by capability set instead of a single Pro boolean", () => {
    expect(
      evaluate(ruleSet, allOn, new URL("https://www.instagram.com/reel/XYZ/"), {
        capabilities: ["surface.instagram.reels"],
      }).kind,
    ).toBe("placeholder");
    expect(
      evaluate(ruleSet, allOn, new URL("https://www.tiktok.com/foryou"), {
        capabilities: ["surface.instagram.reels"],
      }).kind,
    ).toBe("noop");
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

  it("does nothing when the service is off", () => {
    document.body.innerHTML = `<ytd-reel-shelf-renderer id="shelf"></ytd-reel-shelf-renderer>`;
    applyDom(ruleSet, settings({ services: servicesWith("youtube") }), new URL("https://www.youtube.com/"), document);
    expect(document.querySelector("#shelf")).not.toBeNull();
  });
});

describe("generateHideCss (KTD2)", () => {
  const css = generateHideCss(ruleSet);

  it("scopes every rule under the root active class", () => {
    expect(css).toContain(`html.${ROOT_ACTIVE_CLASS}`);
    expect(css).toContain("display:none!important");
  });

  it("includes hide-surface selectors but not remove/redirect/placeholder ones", () => {
    expect(css).toContain("ytd-guide-entry-renderer"); // yt-sidebar (hide)
    expect(css).not.toContain("ytd-reel-shelf-renderer"); // remove-only surface
  });
});
