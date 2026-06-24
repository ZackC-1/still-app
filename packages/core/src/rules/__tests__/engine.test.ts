import { describe, it, expect, beforeEach } from "vitest";
import seed from "../../../rules/seed.json";
import type { SignedRuleSet, StillSettings, ServiceId } from "@still/shared-types";
import { DEFAULT_SETTINGS, SERVICE_IDS } from "@still/shared-types";
import { evaluate, applyDom, generateHideCss, ROOT_ACTIVE_CLASS } from "../engine.js";

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

  it("blocks the whole site on TikTok", () => {
    expect(evaluate(ruleSet, allOn, new URL("https://www.tiktok.com/foryou")).kind).toBe("placeholder");
    expect(evaluate(ruleSet, allOn, new URL("https://www.tiktok.com/@someone")).kind).toBe("placeholder");
  });

  it("placeholders direct Instagram Reels URLs", () => {
    expect(evaluate(ruleSet, allOn, new URL("https://www.instagram.com/reel/XYZ/")).kind).toBe("placeholder");
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
