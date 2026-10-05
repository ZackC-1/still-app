import { types } from "node:util";
import { canonical, hash } from "./plan.mjs";

// Dormant U6/D317/C4 preview model only. No caller, endpoint, database or publisher registers it.
// These are the fixed C4 groups, not evidence of a reviewed release on each surface.
const SURFACES = Object.freeze([
  "chrome_desktop", "edge_desktop", "firefox_desktop", "firefox_android",
  "apple_mobile_host", "apple_macos_host",
]);
const CHANNELS = ["apple", "web"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PREVIEW_MS = 300_000;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw new Error("Invalid policy"); };
// Snapshot data descriptors; object and array accessors must never supply hashed values.
function detach(value) {
  const ancestors = new Set();
  function data(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))) return;
    if (!value || typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) invalid();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const length = array ? descriptors.length.value : 0;
    if (array && keys.length !== length + 1) invalid();
    ancestors.add(value);
    try {
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (typeof key !== "string" || !Object.hasOwn(descriptor, "value")) invalid();
        if (array && key === "length") continue;
        if (!descriptor.enumerable || (array &&
            (!Number.isInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= length))) invalid();
        data(descriptor.value);
      }
    } finally { ancestors.delete(value); }
  }
  try { data(value); return structuredClone(value); } catch { invalid(); }
}
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length ||
      !keys.every(key => Object.hasOwn(value, key)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, "value"))) invalid();
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function list(value, max, check) {
  if (!Array.isArray(value) || value.length > max || new Set(value.map(canonical)).size !== value.length) invalid();
  for (const item of value) check(item);
}
function build(value) {
  exact(value, ["surface", "build"]);
  if (!SURFACES.includes(value.surface) || typeof value.build !== "string" || !ID.test(value.build)) invalid();
}
function product(value, features) {
  exact(value, ["id", "tier", "benefits"]);
  if (value.id !== "still-pro-v3" || value.tier !== "pro" || !value.benefits?.length) invalid();
  list(value.benefits, 32, id => {
    if (typeof id !== "string" || !features.some(f => f.id === id && f.tier === "pro") || id === "tiktok.all" || id === "sync") invalid();
  });
  if (canonical(value.benefits) !== canonical([...value.benefits].sort())) invalid();
}

/** Trusted INTERNAL synthetic ports, never parsed request body or unverified JWT claims.
 * readVerifiedAuth must be supplied by a later cryptographic authentication boundary; this
 * model checks its verified result/owner/mandatory exp and does NOT verify a JWT itself.
 * reviewed represents labelled synthetic reviewed packages/offers/features, not provider proof.
 * readCurrent is a read-only fixture port. No atomic apply, durable preview/idempotency ledger,
 * signature verification, source-file revalidation, first activation or publication is supplied.
 */
export function createSyntheticPolicyPreviewer(ports) {
  const { readVerifiedAuth, readCurrent, now, operationId } = ports;
  if (![readVerifiedAuth, readCurrent, now, operationId].every(fn => typeof fn === "function")) invalid();
  const context = freeze(detach({ environment: ports.environment, sourceRevision: ports.sourceRevision,
    sourceDigest: ports.sourceDigest, ownerSubjects: ports.ownerSubjects, reviewed: ports.reviewed }));
  if (!["sandbox", "production"].includes(context.environment) || !/^[a-f0-9]{40}$/.test(context.sourceRevision) ||
      !DIGEST.test(context.sourceDigest) || !context.ownerSubjects?.length) invalid();
  list(context.ownerSubjects, 16, subject => { if (typeof subject !== "string" || !UUID.test(subject)) invalid(); });
  const reviewed = context.reviewed;
  exact(reviewed, ["features", "product", "builds", "offers"]);
  list(reviewed.features, 32, feature => {
    exact(feature, ["id", "tier"]);
    if (typeof feature.id !== "string" || !ID.test(feature.id) || !["free", "pro"].includes(feature.tier)) invalid();
  });
  if (new Set(reviewed.features.map(f => f.id)).size !== reviewed.features.length) invalid();
  product(reviewed.product, reviewed.features);
  list(reviewed.builds, 32, build);
  list(reviewed.offers, 16, offer => {
    exact(offer, ["id", "channel", "product"]);
    if (typeof offer.id !== "string" || !ID.test(offer.id) || !CHANNELS.includes(offer.channel) || offer.product !== reviewed.product.id) invalid();
  });
  if (new Set(reviewed.offers.map(o => o.id)).size !== reviewed.offers.length) invalid();
  const issued = new WeakSet(); // An internal object brand, NOT a persisted operation ledger.
  function time() {
    const value = now();
    if (!integer(value) || !integer(value + PREVIEW_MS)) invalid();
    return value;
  }
  function owner(auth, at) {
    if (!auth || auth.status !== "verified" || !context.ownerSubjects.includes(auth.subject) ||
        !Number.isFinite(auth.exp) || !Number.isSafeInteger(auth.exp) || auth.exp <= at / 1000) {
      throw new Error("Owner verification required");
    }
    return auth.subject;
  }
  function policy(namespace, value) {
    if (namespace === "sales") {
      exact(value, ["schema", "environment", "app", "paidTierEnabled", "builds", "product", "channels"]);
      if (typeof value.paidTierEnabled !== "boolean") invalid();
      product(value.product, reviewed.features);
      if (canonical(value.product) !== canonical(reviewed.product)) invalid();
      list(value.channels, 2, channel => {
        exact(channel, ["channel", "offer", "enabled"]);
        if (typeof channel.enabled !== "boolean" || !reviewed.offers.some(o => o.channel === channel.channel && o.id === channel.offer && o.product === value.product.id)) invalid();
      });
      if (new Set(value.channels.map(c => c.channel)).size !== value.channels.length) invalid();
    } else if (namespace === "rating") {
      exact(value, ["schema", "environment", "app", "master", "surfaces", "builds"]);
      exact(value.surfaces, SURFACES);
      if (typeof value.master !== "boolean" || !SURFACES.every(s => typeof value.surfaces[s] === "boolean")) invalid();
    } else invalid();
    if (value.schema !== 1 || value.environment !== context.environment || value.app !== "still-app") invalid();
    list(value.builds, 32, candidate => {
      build(candidate);
      if (!reviewed.builds.some(b => canonical(b) === canonical(candidate))) invalid();
    });
    if (Buffer.byteLength(canonical(value)) > 16_384) invalid();
    return value;
  }
  function request(value, admission = false) {
    value = detach(value);
    exact(value, ["namespace", "environment", "expectedRevision", "draft", ...(admission ? ["operationId", "hash"] : [])]);
    if (value.environment !== context.environment || !integer(value.expectedRevision)) invalid();
    policy(value.namespace, value.draft);
    return value;
  }
  function current(namespace, value) {
    value = detach(value);
    exact(value, ["revision", "policy", "cutoff"]);
    if (!integer(value.revision)) invalid();
    if (value.policy !== null) policy(namespace, value.policy);
    if (value.cutoff !== null) {
      exact(value.cutoff, ["product", "benefits", "activatedAt"]);
      if (typeof value.cutoff.product !== "string" || !ID.test(value.cutoff.product) || value.cutoff.product === "still-pro-v3" || !integer(value.cutoff.activatedAt) || value.cutoff.activatedAt === 0) invalid();
      if (!value.cutoff.benefits?.length) invalid();
      list(value.cutoff.benefits, 32, id => { if (!reviewed.features.some(f => f.id === id)) invalid(); });
      if (canonical(value.cutoff.benefits) !== canonical([...value.cutoff.benefits].sort())) invalid();
    }
    return value;
  }
  function effective(namespace, value) {
    if (namespace === "sales") return {
      paidTierEnabled: value?.paidTierEnabled ?? false,
      channels: Object.fromEntries(CHANNELS.map(c => [c, !!(value?.paidTierEnabled && value.builds.length && value.channels.some(x => x.channel === c && x.enabled))])),
    };
    return { master: value?.master ?? false, surfaces: Object.fromEntries(SURFACES.map(s =>
      [s, !!(value?.master && value.surfaces[s] && value.builds.some(b => b.surface === s))])) };
  }
  async function preview(input) {
    const req = request(input); // Detach before any async authority read.
    const auth = structuredClone(await readVerifiedAuth());
    owner(auth, time());
    const state = current(req.namespace, await readCurrent(req.namespace));
    const at = time(); const subject = owner(auth, at);
    if (state.revision !== req.expectedRevision) throw new Error("Stale policy");
    const id = operationId(); if (typeof id !== "string" || !UUID.test(id)) invalid();
    const payload = { schema: 1, kind: "synthetic-policy-preview", productionEvidence: false,
      namespace: req.namespace, environment: context.environment, app: "still-app",
      sourceRevision: context.sourceRevision, sourceDigest: context.sourceDigest, owner: subject,
      operationId: id, expectedRevision: state.revision, createdAt: at, expiresAt: at + PREVIEW_MS,
      bodyHash: hash(canonical(req.draft)), stateHash: hash(canonical(state)), draft: req.draft,
      cutoff: state.cutoff, before: effective(req.namespace, state.policy), after: effective(req.namespace, req.draft) };
    const result = freeze({ ...payload, hash: hash(canonical(payload)) });
    issued.add(result);
    return result;
  }
  async function admit(preview, input) {
    if (!issued.has(preview)) throw new Error("Unknown preview");
    const req = request(input, true);
    const auth = structuredClone(await readVerifiedAuth());
    const subject = owner(auth, time());
    if (subject !== preview.owner) throw new Error("Owner verification required");
    if (req.namespace !== preview.namespace || req.operationId !== preview.operationId || req.hash !== preview.hash ||
        req.expectedRevision !== preview.expectedRevision || hash(canonical(req.draft)) !== preview.bodyHash) throw new Error("Preview changed");
    const state = current(req.namespace, await readCurrent(req.namespace));
    if (state.revision !== preview.expectedRevision || hash(canonical(state)) !== preview.stateHash) throw new Error("Stale policy");
    const at = time(); owner(auth, at);
    if (at < preview.createdAt || at >= preview.expiresAt) throw new Error("Preview expired");
    return preview; // Only admission; no reservation, apply, revision write or published success.
  }
  return Object.freeze({ preview, admit });
}
