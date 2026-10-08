import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { canonicalAccessClaims, accessSigningBytes, STILL_PRO_V3_BENEFITS, type AccessClaims } from "@still/shared-types";
import vectors from "../../../../../tests/access-proof/vectors.json";
import { createModernShippingContentEntry } from "../modern-shipping-entry.js";
import type { ContentScriptHandle } from "../index.js";
import { createFormat2EntryHost } from "./format2-entry-host.js";
import { PACKAGED_RULE_SET_V2 } from "../../rules/packaged.js";
import { extrasFixture } from "../../rules/__tests__/extras-fixtures.js";
import { packagedAccessContext, resolveAccessSnapshot } from "../../entitlement/access-policy.js";
import { verifyAccessProof, type AccessTrust } from "../../entitlement/access-proof.js";
import { EMPTY_ACCESS_RECORD, mutateAccessRecord } from "../../entitlement/access-record.js";

// Explicit paid-on build seam, scoped to this test module. The shipped paid-off gate is tested
// separately in access-capabilities.test.ts. No capability or access state is fabricated here.
vi.mock("@still/shared-types", async (original) => ({
  ...await original<typeof import("@still/shared-types")>(), PAID_TIER_ENABLED: true,
}));

const scripts: ContentScriptHandle[] = [];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const mutations = async () => { await Promise.resolve(); await Promise.resolve(); };
const shown = (id: string): boolean => {
  const node = document.getElementById(id);
  expect(node, id).not.toBeNull();
  for (let at = node; at; at = at.parentElement)
    if (getComputedStyle(at).display === "none") return false;
  return true;
};
const targets = ["keep-related", "target-m-comments-teaser", "target-m-comments-preview",
  "comments-panel-shell", "target-m-comments-panel", "target-m-comments-header", "target-m-comments-scrim"];

afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

describe("Safari modern content entry with observed mobile YouTube structures", () => {
  it.each([true, false])("requires access and On; preserves content and Shorts with :has support %s", async (hasSupported) => {
    vi.stubGlobal("CSS", { supports: () => hasSupported });
    if (!hasSupported) {
      // Model an older CSS parser rejecting only unsupported rules. jsdom itself supports :has;
      // merely stubbing CSS.supports would leave the primary selector hiding the panel.
      const setter = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!.set!;
      vi.spyOn(Node.prototype, "textContent", "set").mockImplementation(function (this: Node, value) {
        setter.call(this, this instanceof HTMLStyleElement && typeof value === "string"
          ? value.split("\n").filter(rule => !rule.includes(":has(")).join("\n") : value);
      });
    }
    vi.stubGlobal("crypto", webcrypto);
    const h = await createFormat2EntryHost(PACKAGED_RULE_SET_V2 as never, "youtube-mobile.html",
      "https://m.youtube.com/watch?v=synthetic-mobile", scripts);
    const fixture = new DOMParser().parseFromString(extrasFixture("yt-m-watch-comments.html"), "text/html");
    document.head.innerHTML = fixture.head.innerHTML;
    document.body.innerHTML = fixture.body.innerHTML;
    document.querySelector("ytm-app")!.insertAdjacentHTML("beforeend", `
      <ytm-reel-shelf-renderer id="free-shorts">Invented Shorts</ytm-reel-shelf-renderer>
      <ytm-engagement-panel id="keep-mixed-panel">
        <ytm-engagement-panel-section-list-renderer class="engagement-panel-comments-section" id="keep-mixed-comments"></ytm-engagement-panel-section-list-renderer>
        <div id="keep-mixed-action">Invented chosen action</div>
      </ytm-engagement-panel>`);
    const original = document.body.innerHTML;
    const kept = [...document.querySelectorAll('[id^="keep-"]')].filter(node => node.id !== "keep-related").map(node => node.id);
    for (const feature of ["youtube.related", "youtube.comments"] as const)
      await h.authority.commitIntent({ path: `sites.${feature}`, value: true, updatedAt: Date.now() });

    // Model the native holder mapping and signed authority projection at the existing broker.
    // The matching Swift tests establish the native transaction-binding/revocation boundary.
    const key = generateKeyPairSync("ed25519"); // disposable synthetic signer; no provider key
    const trust: AccessTrust = { environment: "sandbox", keys: [{ kid: "synthetic-access",
      purpose: "access", environment: "sandbox",
      publicKeyHex: key.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") }] };
    const claims: AccessClaims = { schema: 1, issuer: "still-access", environment: "sandbox", audience: "still-app",
      kind: "paid_apple_local", provenance: "provider_verified", right: vectors.localRight, holder: vectors.localRight,
      product: "still-pro-v3", benefits: STILL_PRO_V3_BENEFITS, ownership_revision: 1,
      verified_at: vectors.verifiedAt, expires_at: vectors.expiresAt };
    const payload = canonicalAccessClaims(claims);
    const verified = await verifyAccessProof(JSON.stringify({ payload: Buffer.from(payload).toString("base64url"),
      kid: "synthetic-access", alg: "ed25519", signature: sign(null, accessSigningBytes(payload), key.privateKey).toString("base64url") }), trust);
    expect(verified.status).toBe("verified");
    if (verified.status !== "verified") throw new Error("Invalid synthetic signed fixture");
    const context = { ...packagedAccessContext("safari"), localRights: new Set([vectors.localRight]) };
    let state = EMPTY_ACCESS_RECORD;
    let snapshot = resolveAccessSnapshot(state, [], context);
    const runtime = chrome.runtime;
    runtime.sendMessage = vi.fn(async () => ({ ok: true, snapshot }));
    await createModernShippingContentEntry({ host: "safari", storage: chrome.storage.local,
      prod: false, earlyRedirect: true, pendingCover: true, win: h.win, doc: document,
      onScriptCreated: script => scripts.push(script) })();
    await tick(); await tick();
    expect(snapshot.states["youtube.comments"]).toBe("verification_required");
    for (const id of targets) expect(shown(id), `${id} unknown`).toBe(true);
    expect(document.querySelector("[data-still-youtube-comments-panel]")).toBeNull();
    expect(shown("free-shorts")).toBe(false);

    const publish = async (revoked = false) => {
      const observed = await mutateAccessRecord(state, { kind: "observe", observation: { wall: 1000 } }, trust);
      state = observed.record;
      snapshot = resolveAccessSnapshot(state, observed.evidence, context);
      if (!revoked) for (const feature of ["youtube.related", "youtube.comments"] as const)
        expect(snapshot.states[feature], feature).toBe("purchased");
      await chrome.storage.local.set({ "still:entitlement": { access: state } });
      await tick(); await tick();
    };
    state = (await mutateAccessRecord(state, { kind: "install", proof: verified.proof, generation: state.generation,
      issuerNow: vectors.verifiedAt, wall: 1000, localRights: context.localRights }, trust)).record;
    await publish();
    for (const id of targets) expect(shown(id), `${id} purchased On`).toBe(false);
    for (const id of kept) expect(shown(id), id).toBe(true);
    if (hasSupported) expect(document.body.innerHTML).toBe(original);
    else expect(document.getElementById("comments-panel-shell")!.hasAttribute("data-still-youtube-comments-panel")).toBe(true);

    await h.authority.commitIntent({ path: "sites.youtube.shorts", value: false, updatedAt: Date.now() });
    expect(shown("free-shorts")).toBe(true);
    for (const id of targets) expect(shown(id), `${id} Shorts Off`).toBe(false);
    await h.authority.commitIntent({ path: "sites.youtube.shorts", value: true, updatedAt: Date.now() });
    for (const path of ["services.youtube", "globalOn"] as const) {
      await h.authority.commitIntent({ path, value: false, updatedAt: Date.now() });
      for (const id of [...targets, "free-shorts"]) expect(shown(id), `${id} ${path} Off`).toBe(true);
      expect(document.querySelector("[data-still-youtube-comments-panel]")).toBeNull();
      await h.authority.commitIntent({ path, value: true, updatedAt: Date.now() });
      for (const id of [...targets, "free-shorts"]) expect(shown(id), `${id} ${path} On`).toBe(false);
    }

    for (const feature of ["youtube.related", "youtube.comments"] as const) {
      await h.authority.commitIntent({ path: `sites.${feature}`, value: false, updatedAt: Date.now() });
      for (const id of feature === "youtube.related" ? ["keep-related"] : targets.filter(id => id !== "keep-related"))
        expect(shown(id), `${id} Off`).toBe(true);
      expect(shown("free-shorts")).toBe(false);
      if (feature === "youtube.comments") expect(document.querySelector("[data-still-youtube-comments-panel]")).toBeNull();
      await h.authority.commitIntent({ path: `sites.${feature}`, value: true, updatedAt: Date.now() });
    }

    // Recycled sole-child modal becomes mixed and stops hiding its parent's shared actions.
    const shell = document.getElementById("comments-panel-shell")!;
    shell.insertAdjacentHTML("beforeend", '<button id="late-chosen-action">Invented chosen action</button>');
    if (!hasSupported) await mutations(); // Deliver mutations in this microtask checkpoint, before paint.
    expect(shown(shell.id)).toBe(true);
    expect(shown("late-chosen-action")).toBe(true);
    expect(shown("target-m-comments-panel")).toBe(true);
    shell.lastElementChild!.remove(); // simulated page renderer, never extension mutation
    if (!hasSupported) await mutations();
    expect(shown(shell.id)).toBe(false);
    const section = shell.firstElementChild!;
    section.classList.remove("engagement-panel-comments-section");
    if (!hasSupported) await mutations();
    expect(shown(shell.id)).toBe(true);
    section.classList.add("engagement-panel-comments-section");
    if (!hasSupported) await mutations();
    expect(shown(shell.id)).toBe(false);
    shell.insertAdjacentHTML("afterend", '<ytm-engagement-panel id="late-comments"><ytm-engagement-panel-section-list-renderer class="engagement-panel-comments-section"></ytm-engagement-panel-section-list-renderer></ytm-engagement-panel>');
    if (!hasSupported) await mutations();
    expect(shown("late-comments")).toBe(false);
    h.win.history.pushState(null, "", "/watch?v=synthetic-second&list=chosen");
    await tick(); await tick();
    expect(shown("keep-chosen-playlist")).toBe(true);
    expect(shown("keep-related")).toBe(false);

    state = (await mutateAccessRecord(state, { kind: "revoke", right: verified.proof.claims.right,
      revision: verified.proof.claims.ownership_revision, generation: state.generation }, trust)).record;
    await publish(true);
    for (const id of targets) expect(shown(id), `${id} revoked`).toBe(true);
    expect(shown("late-comments")).toBe(true);
    expect(document.querySelector("[data-still-youtube-comments-panel]")).toBeNull();
    for (const id of kept) expect(shown(id), id).toBe(true);
    expect(shown("free-shorts")).toBe(false);
    expect(h.replace).not.toHaveBeenCalled();
    scripts[0]!.stop();
    expect(shown("free-shorts")).toBe(true);
    expect([...document.documentElement.classList].filter(name => name.startsWith("still-"))).toEqual([]);
    document.getElementById("late-comments")!.remove();
    expect(document.body.innerHTML).toBe(original);
  });
});
