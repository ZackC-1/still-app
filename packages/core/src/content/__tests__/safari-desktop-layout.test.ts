import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { canonicalAccessClaims, accessSigningBytes, STILL_PRO_V3_BENEFITS, type AccessClaims, type FeatureId } from "@still/shared-types";
import vectors from "../../../../../tests/access-proof/vectors.json";
import { createModernShippingContentEntry } from "../modern-shipping-entry.js";
import type { ContentScriptHandle } from "../index.js";
import { createFormat2EntryHost } from "./format2-entry-host.js";
import { PACKAGED_RULE_SET_V2 } from "../../rules/packaged.js";
import { extrasFixture } from "../../rules/__tests__/extras-fixtures.js";
import { packagedAccessContext, resolveAccessSnapshot, type AccessPlatform } from "../../entitlement/access-policy.js";
import { verifyAccessProof, type AccessTrust, type VerifiedAccessProof } from "../../entitlement/access-proof.js";
import { EMPTY_ACCESS_RECORD, mutateAccessRecord } from "../../entitlement/access-record.js";

// Safari's shared content entry on the DESKTOP layouts that macOS Safari loads (www.youtube.com,
// www.facebook.com). The content entry passes only its host; the per-device limit comes from the
// access snapshot, which the native app resolves per Apple platform (macOS: desktop; iPhone/iPad:
// ios) and which is modelled here with the same TypeScript rule the parity fixture pins to Swift.
// Explicit paid-on build seam, scoped to this module; no capability or state is fabricated.
vi.mock("@still/shared-types", async (original) => ({
  ...await original<typeof import("@still/shared-types")>(), PAID_TIER_ENABLED: true,
}));

const scripts: ContentScriptHandle[] = [];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const shown = (id: string): boolean => {
  const node = document.getElementById(id);
  expect(node, id).not.toBeNull();
  for (let at = node; at; at = at.parentElement)
    if (getComputedStyle(at).display === "none") return false;
  return true;
};
const ids = (prefix: "target-" | "keep-") => [...document.querySelectorAll(`[id^="${prefix}"]`)].map((node) => node.id);

afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

async function signedProof(): Promise<{ proof: VerifiedAccessProof; trust: AccessTrust }> {
  const key = generateKeyPairSync("ed25519"); // disposable synthetic signer; no provider key
  const trust: AccessTrust = { environment: "sandbox", keys: [{ kid: "synthetic-access", purpose: "access", environment: "sandbox",
    publicKeyHex: key.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") }] };
  const claims: AccessClaims = { schema: 1, issuer: "still-access", environment: "sandbox", audience: "still-app",
    kind: "paid_apple_local", provenance: "provider_verified", right: vectors.localRight, holder: vectors.localRight,
    product: "still-pro-v3", benefits: STILL_PRO_V3_BENEFITS, ownership_revision: 1,
    verified_at: vectors.verifiedAt, expires_at: vectors.expiresAt };
  const payload = canonicalAccessClaims(claims);
  const verified = await verifyAccessProof(JSON.stringify({ payload: Buffer.from(payload).toString("base64url"),
    kid: "synthetic-access", alg: "ed25519", signature: sign(null, accessSigningBytes(payload), key.privateKey).toString("base64url") }), trust);
  if (verified.status !== "verified") throw new Error("Invalid synthetic signed fixture");
  return { proof: verified.proof, trust };
}

/**
 * Runs Safari's modern content entry over `file` at `href` with a purchased Still Pro right whose
 * snapshot is resolved for `platform`, the way the native app answers on that Apple platform.
 */
async function safariPage(file: string, href: string, features: readonly FeatureId[], platform: AccessPlatform) {
  vi.stubGlobal("crypto", webcrypto);
  const h = await createFormat2EntryHost(PACKAGED_RULE_SET_V2 as never, `extras/${file}`, href, scripts);
  document.body.innerHTML = new DOMParser().parseFromString(extrasFixture(file), "text/html").body.innerHTML;
  for (const feature of features) await h.authority.commitIntent({ path: `sites.${feature}`, value: true, updatedAt: Date.now() });
  const { proof, trust } = await signedProof();
  const context = { ...packagedAccessContext("safari", platform), localRights: new Set([vectors.localRight]) };
  let state = EMPTY_ACCESS_RECORD;
  let snapshot = resolveAccessSnapshot(state, [], context);
  chrome.runtime.sendMessage = vi.fn(async () => ({ ok: true, snapshot }));
  await createModernShippingContentEntry({ host: "safari", storage: chrome.storage.local,
    prod: false, earlyRedirect: true, pendingCover: true, win: h.win, doc: document,
    onScriptCreated: (script) => scripts.push(script) })();
  await tick(); await tick();
  const publish = async () => {
    const observed = await mutateAccessRecord(state, { kind: "observe", observation: { wall: 1000 } }, trust);
    state = observed.record;
    snapshot = resolveAccessSnapshot(state, observed.evidence, context);
    await chrome.storage.local.set({ "still:entitlement": { access: state } });
    await tick(); await tick();
  };
  state = (await mutateAccessRecord(state, { kind: "install", proof, generation: state.generation,
    issuerNow: vectors.verifiedAt, wall: 1000, localRights: context.localRights }, trust)).record;
  await publish();
  return {
    h,
    state: () => snapshot.states,
    async revoke() {
      state = (await mutateAccessRecord(state, { kind: "revoke", right: proof.claims.right,
        revision: proof.claims.ownership_revision, generation: state.generation }, trust)).record;
      await publish();
    },
  };
}

describe("Safari content entry on the desktop layouts macOS Safari loads", () => {
  it.each([
    { name: "YouTube end-of-video suggestions", file: "yt-watch-end.html", href: "https://www.youtube.com/watch?v=inv200000", feature: "youtube.endscreen" },
    { name: "YouTube live chat", file: "yt-watch-comments-chat.html", href: "https://www.youtube.com/watch?v=inv400001", feature: "youtube.livechat" },
    { name: "Facebook Desktop sidebar ads", file: "fb-sidebar.html", href: "https://www.facebook.com/", feature: "facebook.sponsored" },
  ] as const)("$name: purchased and On hides its targets on macOS; Off, revocation and iPhone/iPad leave everything", async ({ file, href, feature }) => {
    const live = await safariPage(file, href, [feature], "desktop");
    expect(live.state()[feature]).toBe("purchased");
    const targets = ids("target-").filter((id) => feature !== "youtube.livechat" || id.startsWith("target-chat"));
    expect(targets.length).toBeGreaterThan(0);
    const kept = ids("keep-");
    for (const id of targets) expect(shown(id), `${id} hidden on macOS`).toBe(false);
    for (const id of kept) expect(shown(id), `${id} kept`).toBe(true);

    await live.h.authority.commitIntent({ path: `sites.${feature}`, value: false, updatedAt: Date.now() });
    for (const id of targets) expect(shown(id), `${id} Off`).toBe(true);
    await live.h.authority.commitIntent({ path: `sites.${feature}`, value: true, updatedAt: Date.now() });
    for (const id of targets) expect(shown(id), `${id} On again`).toBe(false);

    await live.revoke();
    expect(live.state()[feature]).toBe("verification_required");
    for (const id of [...targets, ...kept]) expect(shown(id), `${id} revoked`).toBe(true);
    scripts[0]!.stop();
    expect([...document.documentElement.classList].filter((name) => name.startsWith("still-"))).toEqual([]);
  });

  it.each([
    { file: "yt-watch-end.html", href: "https://www.youtube.com/watch?v=inv200000", feature: "youtube.endscreen" },
    { file: "yt-watch-comments-chat.html", href: "https://www.youtube.com/watch?v=inv400001", feature: "youtube.livechat" },
    { file: "fb-sidebar.html", href: "https://www.facebook.com/", feature: "facebook.sponsored" },
  ] as const)("iPhone/iPad Safari ($feature): the same purchase and saved On is never a desktop-layout control", async ({ file, href, feature }) => {
    const phone = await safariPage(file, href, [feature], "ios");
    expect(phone.state()[feature]).toBe("unsupported");
    for (const id of [...ids("target-"), ...ids("keep-")]) expect(shown(id), id).toBe(true);
    // The phone-layout extras of the same purchase stay purchased.
    expect(phone.state()["youtube.autoplay"]).toBe("purchased");
    expect(phone.state()["youtube.comments"]).toBe("purchased");
  });

  it("YouTube Autoplay prevention cancels the countdown on macOS, and on iPhone/iPad in either layout", async () => {
    for (const [platform, file, href] of [
      ["desktop", "yt-autoplay.html", "https://www.youtube.com/watch?v=inv300001"],
      ["ios", "yt-autoplay.html", "https://www.youtube.com/watch?v=inv300001"], // iPad requesting the desktop site
      ["ios", "yt-m-autoplay.html", "https://m.youtube.com/watch?v=inv300001"], // the observed phone countdown
    ] as const) {
      const page = await safariPage(file, href, ["youtube.autoplay"], platform);
      expect(page.state()["youtube.autoplay"], platform).toBe("purchased");
      let cancels = 0;
      let toggles = 0;
      document.getElementById("keep-autonav-cancel")!.addEventListener("click", () => cancels++);
      document.getElementById("keep-autoplay-toggle")!.addEventListener("click", () => toggles++);
      document.getElementById("player-video")!.dispatchEvent(new Event("ended"));
      await tick();
      expect({ cancels, toggles }, `${platform} ${file}`).toEqual({ cancels: 1, toggles: 0 });
      expect(page.h.replace).not.toHaveBeenCalled();
      for (const script of scripts.splice(0)) script.stop();
    }
  });
});
