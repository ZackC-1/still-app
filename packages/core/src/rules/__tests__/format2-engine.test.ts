import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BenefitAccessSnapshot, type SignedRuleSetV2 } from "@still/shared-types";
import { createEnginePageSession, type EnginePageSession } from "../engine.js";
import { ruleSet, on, access, capabilities, url, DEFAULT_SETTINGS_V2 } from "./format2-fixtures.js";

const sessions: EnginePageSession[] = [];
function session(input: SignedRuleSetV2 = ruleSet) { const value = createEnginePageSession(input); sessions.push(value); return value; }
function display(id: string) { return getComputedStyle(document.getElementById(id)!).display; }
beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; document.documentElement.className = "site-theme"; });
afterEach(() => { for (const value of sessions.splice(0)) value.stop?.(); vi.restoreAllMocks(); });

describe("format2 committed effective/reversible engine", () => {
  it("hides only current per-feature targets and reverses Off without deleting or editing site nodes", () => {
    document.body.innerHTML = '<div id="target" class="shorts site-card" style="color:red">Short</div><div id="comments" class="comments">Comment</div><div id="preserved" class="shorts"><span class="preserve">Normal</span></div>';
    const target = document.getElementById("target")!; const before = target.outerHTML; const engine = session();
    engine.applyDom(on, url, document, { access, capabilities });
    expect(display("target")).toBe("none"); expect(display("comments")).toBe("none"); expect(display("preserved")).not.toBe("none");
    expect(target.outerHTML).toBe(before);
    engine.applyDom({ ...on, sites: { ...on.sites, "youtube.shorts": false } }, url, document, { access, capabilities });
    expect(display("target")).not.toBe("none"); expect(display("comments")).toBe("none");
    expect(target.outerHTML).toBe(before); expect(document.documentElement.classList.contains("site-theme")).toBe(true);
  });
  it("retains fresh extras Off and denies global/service/domain/capability/unknown access gates", () => {
    document.body.innerHTML = '<div id="target" class="shorts"></div><div id="comments" class="comments"></div>'; const engine = session();
    engine.applyDom(DEFAULT_SETTINGS_V2, url, document, { access, capabilities }); expect(display("target")).toBe("none"); expect(display("comments")).not.toBe("none");
    for (const settings of [{ ...on, globalOn: false }, { ...on, services: { ...on.services, youtube: false } }, { ...on, pauses: ["youtube.com"] }]) {
      engine.applyDom(settings, url, document, { access, capabilities }); expect(display("target")).not.toBe("none"); expect(display("comments")).not.toBe("none");
    }
    engine.applyDom(on, url, document, { access, capabilities: new Set() }); expect(display("target")).not.toBe("none");
    for (const state of ["locked", "checking", "verification_required", "unsupported"] as const) {
      const held: BenefitAccessSnapshot = { ...access, states: { ...access.states, "youtube.shorts": state, "youtube.comments": state } };
      engine.applyDom(on, url, document, { access: held, capabilities }); expect(display("target")).not.toBe("none"); expect(display("comments")).not.toBe("none");
    }
  });
  it("gates every branch of selector lists and keeps preexisting foreign hiding after retraction", () => {
    document.body.innerHTML = '<div id="a" class="comments"></div><div id="b" class="comments-second"></div><div id="foreign" class="comments-second" style="display:none!important"></div>';
    const engine = session(); engine.applyDom(on, url, document, { access, capabilities }); expect(display("a")).toBe("none"); expect(display("b")).toBe("none");
    engine.applyDom({ ...on, sites: { ...on.sites, "youtube.comments": false } }, url, document, { access, capabilities });
    expect(display("a")).not.toBe("none"); expect(display("b")).not.toBe("none"); expect(display("foreign")).toBe("none");
  });
  it("recycled/removed/reinserted nodes match current attributes immediately without a new DOM sweep", () => {
    document.body.innerHTML = '<div id="card" class="recycled" data-kind="short"></div>'; const engine = session();
    engine.applyDom(on, url, document, { access, capabilities }); const card = document.getElementById("card")!; expect(display("card")).toBe("none");
    const queries = vi.spyOn(document, "querySelectorAll");
    card.setAttribute("data-kind", "normal"); expect(display("card")).not.toBe("none"); card.remove(); card.setAttribute("data-kind", "short"); document.body.append(card);
    expect(display("card")).toBe("none"); expect(queries).not.toHaveBeenCalled(); expect(card.getAttribute("style")).toBeNull();
  });
  it("retains ordinary children/listeners through nested preserve changes", () => {
    document.body.innerHTML = '<section id="parent" class="shorts"><button id="ordinary">Play</button></section>';
    const click = vi.fn(); const ordinary = document.getElementById("ordinary")!; ordinary.addEventListener("click", click); const engine = session();
    engine.applyDom(on, url, document, { access, capabilities }); expect(display("parent")).toBe("none"); ordinary.classList.add("preserve"); expect(display("parent")).not.toBe("none");
    ordinary.dispatchEvent(new MouseEvent("click")); expect(click).toHaveBeenCalledTimes(1); expect(ordinary.parentElement).toBe(document.getElementById("parent"));
  });
  it("a committed access transition retracts grants, preserves saved Off, and avoids recompile for unchanged inputs", () => {
    document.body.innerHTML = '<div id="comments" class="comments"></div>'; const engine = session(); const off = { ...on, sites: { ...on.sites, "youtube.comments": false } };
    for (const state of ["purchased", "protected", "free"] as const) {
      const grant = { ...access, generation: access.generation + 1, states: { ...access.states, "youtube.comments": state } };
      engine.applyDom(off, url, document, { access: grant, capabilities }); expect(display("comments")).not.toBe("none");
    }
    const before = JSON.stringify(off); engine.applyDom(on, url, document, { access, capabilities }); expect(display("comments")).toBe("none");
    const resolutions = engine.debugStats().serviceResolutions;
    for (let i = 0; i < 50; i++) engine.applyDom(on, url, document, { access, capabilities }); expect(engine.debugStats().serviceResolutions).toBe(resolutions);
    engine.applyDom(on, url, document, { access: { ...access, generation: 5, states: { ...access.states, "youtube.comments": "verification_required" } }, capabilities });
    expect(display("comments")).not.toBe("none"); expect(JSON.stringify(off)).toBe(before);
  });
  it("TikTok reads only its service alias and yields a blocked decision without replacing the body", () => {
    const engine = session(); document.body.innerHTML = '<div id="ordinary">Keep</div>'; const tt = new URL("https://www.tiktok.com/foryou");
    expect(engine.evaluate(on, tt, { access, capabilities })).toEqual({ kind: "placeholder", blocked: true });
    expect(engine.evaluate({ ...on, services: { ...on.services, tiktok: false } }, tt, { access, capabilities })).toEqual({ kind: "noop" });
    engine.applyDom(on, tt, document, { access, capabilities }); expect(document.getElementById("ordinary")).not.toBeNull(); expect(document.getElementById("still-placeholder")).toBeNull();
  });
  it("strictly validates format2 input and snapshots it before subsequent caller mutation", () => {
    expect(() => session({ ...ruleSet, remoteCode: "execute()" } as SignedRuleSetV2)).toThrow();
    const mutable = structuredClone(ruleSet); const engine = session(mutable);
    const surface = mutable.services.youtube!.surfaces[0]!;
    if (surface.action !== "hide") throw new Error("Expected hide fixture");
    Reflect.set(surface, "selectors", [".ordinary"]);
    document.body.innerHTML = '<div id="target" class="shorts"></div><div id="keep" class="ordinary"></div>'; engine.applyDom(on, url, document, { access, capabilities });
    expect(display("target")).toBe("none"); expect(display("keep")).not.toBe("none");
  });
  it("stop removes only owned effects, restores foreign CSS, and fences late apply", () => {
    const foreign = document.createElement("style"); foreign.textContent = '.site-theme .foreign{display:none!important}'; document.head.append(foreign);
    document.body.innerHTML = '<div id="target" class="shorts"></div><div id="foreign" class="foreign"></div>'; const engine = session(); engine.applyDom(on, url, document, { access, capabilities });
    expect(display("target")).toBe("none"); engine.stop?.(); expect(display("target")).not.toBe("none"); expect(display("foreign")).toBe("none"); expect(foreign.isConnected).toBe(true);
    engine.applyDom({ ...on }, url, document, { access: { ...access, generation: 2 }, capabilities });
    expect(display("target")).not.toBe("none"); expect(document.documentElement.className).toBe("site-theme");
    expect(document.head.querySelectorAll("style")).toHaveLength(1); expect(foreign.isConnected).toBe(true);
  });
  it("isolates service selectors and holds legacy settings without inventing feature intentions", () => {
    document.body.innerHTML = '<div id="target" class="shorts"></div><div id="comments" class="comments"></div>';
    const engine = session(); const instagram = new URL("https://www.instagram.com/");
    engine.applyDom(on, instagram, document, { access, capabilities });
    expect(display("target")).toBe("none"); expect(display("comments")).not.toBe("none");
    const { schemaVersion: _schema, sites: _sites, ...legacy } = on;
    engine.applyDom({ ...legacy, pauses: [] }, url, document, { access, capabilities });
    expect(display("target")).not.toBe("none"); expect(document.head.querySelectorAll("style")).toHaveLength(0);
    engine.applyDom(on, new URL("https://unrelated.example/"), document, { access, capabilities });
    expect(document.documentElement.className).toBe("site-theme");
  });
});
