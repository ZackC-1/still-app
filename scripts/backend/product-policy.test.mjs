import assert from "node:assert/strict";
import { test } from "node:test";
import { canonical, hash } from "./plan.mjs";
import { createSyntheticPolicyPreviewer } from "./product-policy.mjs";

// Every identifier, offer, reviewed build and existing cutoff here is synthetic.
const owner = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const surfaces = {
  chrome_desktop: false, edge_desktop: false, firefox_desktop: false,
  firefox_android: false, apple_mobile_host: false, apple_macos_host: false,
};
function fixture({ reviewedBenefit = "youtube.comments",
  reviewedBuilds = [{ surface: "chrome_desktop", build: "synthetic-1" }] } = {}) {
  let now = 1_800_000_000_000;
  let auth = { status: "verified", subject: owner, exp: now / 1000 + 600 };
  let state = { revision: 4, policy: null, cutoff: null };
  let nextRead = null;
  const features = [{ id: "youtube.shorts", tier: "free" }, { id: "youtube.comments", tier: "pro" }, { id: "tiktok.all", tier: "free" }];
  if (reviewedBenefit !== "youtube.comments") {
    const feature = features.find(f => f.id === reviewedBenefit);
    if (feature) feature.tier = "pro";
    else features.push({ id: reviewedBenefit, tier: "pro" });
  }
  const authority = createSyntheticPolicyPreviewer({
    environment: "sandbox", sourceRevision: "a".repeat(40), sourceDigest: "b".repeat(64),
    ownerSubjects: [owner],
    reviewed: {
      features,
      product: { id: "still-pro-v3", benefits: [reviewedBenefit], tier: "pro" },
      builds: reviewedBuilds,
      offers: [{ id: "synthetic-web-lifetime", channel: "web", product: "still-pro-v3" }],
    },
    readVerifiedAuth: async () => auth,
    readCurrent: async () => {
      const gate = nextRead; nextRead = null;
      if (gate) { gate.started(); await gate.opened; }
      return state;
    },
    now: () => now, operationId: () => operationId,
  });
  const draft = {
    schema: 1, environment: "sandbox", app: "still-app", paidTierEnabled: true,
    builds: [{ surface: "chrome_desktop", build: "synthetic-1" }],
    product: { id: "still-pro-v3", benefits: [reviewedBenefit], tier: "pro" },
    channels: [{ channel: "web", offer: "synthetic-web-lifetime", enabled: true }],
  };
  const request = { namespace: "sales", environment: "sandbox", expectedRevision: 4, draft };
  return { authority, draft, request, state: () => state, setState: value => { state = value; },
    setAuth: value => { auth = value; }, setNow: value => { now = value; }, now: () => now,
    pauseNextRead: () => {
      assert.equal(nextRead, null);
      let started, release;
      const reached = new Promise(resolve => { started = resolve; });
      const opened = new Promise(resolve => { release = resolve; });
      nextRead = { started, opened };
      return { reached, release };
    } };
}
function admission(f, preview) {
  return { ...f.request, operationId: preview.operationId, hash: preview.hash };
}
function accessorBuild(validReads = 3) {
  let reads = 0;
  const builds = [];
  Object.defineProperty(builds, "0", { enumerable: true, get: () => ({
    surface: "chrome_desktop", build: ++reads <= validReads ? "synthetic-1" : "*",
  }) });
  return { builds, reads: () => reads };
}
function objectAccessorBuild() {
  let reads = 0;
  const value = { surface: "chrome_desktop" };
  Object.defineProperty(value, "build", { enumerable: true, get: () => {
    reads += 1;
    return "synthetic-1";
  } });
  return { builds: [value], reads: () => reads };
}
function selfRemovingBuildProxy(draft) {
  const builds = draft.builds;
  let traps = 0, getters = 0;
  draft.builds = new Proxy(builds, { getPrototypeOf: () => {
    traps += 1;
    draft.builds = builds;
    Object.defineProperty(draft, "paidTierEnabled", { enumerable: true, configurable: true,
      get: () => {
        getters += 1;
        Object.defineProperty(draft, "paidTierEnabled", {
          value: true, enumerable: true, configurable: true, writable: true,
        });
        return true;
      } });
    return Array.prototype;
  } });
  return { counts: () => ({ traps, getters }) };
}
function countedProxy(value) {
  let traps = 0;
  const proxy = new Proxy(value, { getPrototypeOf: () => {
    traps += 1;
    return Object.getPrototypeOf(value);
  } });
  return { proxy, traps: () => traps };
}

test("valid synthetic preview binds exact body/source and retains current cutoff without publishing", async () => {
  const f = fixture();
  const before = structuredClone(f.state());
  const p = await f.authority.preview(f.request);
  assert.equal(p.productionEvidence, false);
  assert.equal(p.kind, "synthetic-policy-preview");
  assert.equal(p.expectedRevision, 4);
  assert.equal(p.sourceRevision, "a".repeat(40));
  assert.equal(p.sourceDigest, "b".repeat(64));
  assert.equal(p.expiresAt - p.createdAt, 300_000);
  assert.equal(p.bodyHash, hash(canonical(f.draft)));
  const { hash: digest, ...payload } = p;
  assert.equal(digest, hash(canonical(payload)));
  assert.equal(p.cutoff, null); // A proposed paid draft never manufactures a first activation.
  assert.equal(p.before.paidTierEnabled, false);
  assert.equal(p.before.channels.web, false);
  assert.equal(p.after.channels.web, true); // Proposed effect, never a published policy.
  assert.equal(await f.authority.admit(p, admission(f, p)), p);
  assert.deepEqual(f.state(), before);
});

test("reserved TikTok and sync benefits stay free even when reviewed as Pro", async () => {
  const f = fixture({ reviewedBenefit: "youtube.comments" });
  const before = structuredClone(f.state());
  const p = await f.authority.preview(f.request);
  assert.equal(await f.authority.admit(p, admission(f, p)), p);
  assert.deepEqual(f.state(), before);
  for (const reviewedBenefit of ["tiktok.all", "sync"]) {
    assert.throws(() => fixture({ reviewedBenefit }), /Invalid policy/);
  }
});

test("preview rejects owner expiry while its current-state read is pending", async () => {
  const f = fixture();
  f.setAuth({ status: "verified", subject: owner, exp: f.now() / 1000 + 60 });
  const before = JSON.stringify(f.state());
  const gate = f.pauseNextRead();
  const pending = f.authority.preview(f.request);
  await gate.reached;
  f.setNow(f.now() + 61_000);
  gate.release();
  await assert.rejects(pending, /Owner verification required/);
  assert.equal(JSON.stringify(f.state()), before);
});

test("admission rejects owner expiry during its read before the preview expires", async () => {
  const f = fixture();
  const p = await f.authority.preview(f.request);
  f.setAuth({ status: "verified", subject: owner, exp: f.now() / 1000 + 60 });
  const before = JSON.stringify(f.state());
  const gate = f.pauseNextRead();
  const pending = f.authority.admit(p, admission(f, p));
  await gate.reached;
  f.setNow(f.now() + 61_000);
  assert.ok(f.now() < p.expiresAt);
  gate.release();
  await assert.rejects(pending, /Owner verification required/);
  assert.equal(JSON.stringify(f.state()), before);
});

test("preview rejects an executable build index before cloning an unreviewed draft", async () => {
  const f = fixture();
  const before = structuredClone(f.state());
  const getter = accessorBuild();
  f.draft.builds = getter.builds;
  await assert.rejects(f.authority.preview(f.request), /Invalid policy/);
  assert.equal(getter.reads(), 0);
  assert.deepEqual(f.state(), before);
});

test("admission rejects a build accessor even if every read returns the reviewed build", async () => {
  const f = fixture();
  const p = await f.authority.preview(f.request);
  const before = structuredClone(f.state());
  const getter = accessorBuild(Infinity);
  f.draft.builds = getter.builds;
  await assert.rejects(f.authority.admit(p, admission(f, p)), /Invalid policy/);
  assert.equal(getter.reads(), 0);
  assert.deepEqual(f.state(), before);
});

test("current-state policy rejects an executable build index at the actual read port", async () => {
  const f = fixture();
  const getter = accessorBuild();
  const state = { revision: 4, policy: { ...f.draft, builds: getter.builds }, cutoff: null };
  f.setState(state);
  await assert.rejects(f.authority.preview(f.request), /Invalid policy/);
  assert.equal(getter.reads(), 0);
  assert.equal(f.state(), state);
});

test("reviewed constructor data rejects build accessors without executing them", () => {
  const getter = accessorBuild(Infinity);
  assert.throws(() => fixture({ reviewedBuilds: getter.builds }), /Invalid policy/);
  assert.equal(getter.reads(), 0);
});

test("preview rejects a plain-object build getter without executing it", async () => {
  const f = fixture();
  const before = JSON.stringify(f.state());
  const getter = objectAccessorBuild();
  f.draft.builds = getter.builds;
  await assert.rejects(f.authority.preview(f.request), /Invalid policy/);
  assert.equal(getter.reads(), 0);
  assert.equal(JSON.stringify(f.state()), before);
});

test("admission rejects a plain-object build getter without executing it", async () => {
  const f = fixture();
  const p = await f.authority.preview(f.request);
  const before = JSON.stringify(f.state());
  const getter = objectAccessorBuild();
  f.draft.builds = getter.builds;
  await assert.rejects(f.authority.admit(p, admission(f, p)), /Invalid policy/);
  assert.equal(getter.reads(), 0);
  assert.equal(JSON.stringify(f.state()), before);
});

test("current-state data rejects a plain-object build getter without executing it", async () => {
  const f = fixture();
  const getter = objectAccessorBuild();
  const state = { revision: 4, policy: { ...f.draft, builds: getter.builds }, cutoff: null };
  f.setState(state);
  await assert.rejects(f.authority.preview(f.request), /Invalid policy/);
  assert.equal(getter.reads(), 0);
  assert.equal(f.state(), state);
  assert.equal(state.policy.builds, getter.builds);
});

test("reviewed constructor data rejects a plain-object build getter without executing it", () => {
  const getter = objectAccessorBuild();
  assert.throws(() => fixture({ reviewedBuilds: getter.builds }), /Invalid policy/);
  assert.equal(getter.reads(), 0);
});

test("preview rejects a self-removing Proxy before its trap installs a getter", async () => {
  const f = fixture();
  const before = structuredClone(f.state());
  const executable = selfRemovingBuildProxy(f.draft);
  await assert.rejects(f.authority.preview(f.request), /Invalid policy/);
  assert.deepEqual(executable.counts(), { traps: 0, getters: 0 });
  assert.deepEqual(f.state(), before);
});

test("admission rejects a self-removing Proxy before its trap installs a getter", async () => {
  const f = fixture();
  const p = await f.authority.preview(f.request);
  const before = structuredClone(f.state());
  const executable = selfRemovingBuildProxy(f.draft);
  await assert.rejects(f.authority.admit(p, admission(f, p)), /Invalid policy/);
  assert.deepEqual(executable.counts(), { traps: 0, getters: 0 });
  assert.deepEqual(f.state(), before);
});

test("current-state data rejects a Proxy without executing its reflection trap", async () => {
  const f = fixture();
  const executable = countedProxy({ ...f.draft });
  const state = { revision: 4, policy: executable.proxy, cutoff: null };
  f.setState(state);
  await assert.rejects(f.authority.preview(f.request), /Invalid policy/);
  assert.equal(executable.traps(), 0);
  assert.equal(f.state(), state);
  assert.equal(state.policy, executable.proxy);
});

test("reviewed constructor data rejects a Proxy without executing its reflection trap", () => {
  const executable = countedProxy([{ surface: "chrome_desktop", build: "synthetic-1" }]);
  assert.throws(() => fixture({ reviewedBuilds: executable.proxy }), /Invalid policy/);
  assert.equal(executable.traps(), 0);
});

test("all data ports reject a revoked Proxy without executing its handler", async () => {
  for (const port of ["preview", "admission", "current", "context"]) {
    const f = fixture();
    const p = port === "admission" ? await f.authority.preview(f.request) : null;
    const before = f.state();
    const value = port === "context" ? f.draft.builds : port === "current" ? f.draft :
      port === "admission" ? admission(f, p) : f.request;
    let traps = 0;
    const { proxy, revoke } = Proxy.revocable(value, { getPrototypeOf: () => {
      traps += 1;
      return Object.getPrototypeOf(value);
    } });
    revoke();
    if (port === "context") assert.throws(() => fixture({ reviewedBuilds: proxy }), /Invalid policy/);
    else if (port === "current") {
      const state = { revision: 4, policy: proxy, cutoff: null };
      f.setState(state);
      await assert.rejects(f.authority.preview(f.request), /Invalid policy/);
      assert.equal(f.state(), state);
      assert.equal(state.policy, proxy);
    } else if (port === "admission") await assert.rejects(f.authority.admit(p, proxy), /Invalid policy/);
    else await assert.rejects(f.authority.preview(proxy), /Invalid policy/);
    assert.equal(traps, 0);
    if (port !== "current") assert.equal(f.state(), before);
  }
});

test("detachment keeps cyclic and nonplain request data invalid", async () => {
  for (const change of [f => { f.draft.builds = new Proxy(f.draft.builds, {}); },
    f => { f.draft.builds[0] = f.draft.builds; }, f => { f.draft.builds[0] = new Date(0); }]) {
    const f = fixture();
    const before = structuredClone(f.state());
    change(f);
    await assert.rejects(f.authority.preview(f.request));
    assert.deepEqual(f.state(), before);
  }
});

test("owner admission uses only current verified auth result with mandatory unexpired exp", async () => {
  for (const auth of [null, { status: "unverified", subject: owner, exp: 1e12 },
    { status: "verified", subject: stranger, exp: 1e12 },
    { status: "verified", subject: owner }, { status: "verified", subject: owner, exp: NaN },
    { status: "verified", subject: owner, exp: Infinity },
    { status: "verified", subject: owner, exp: 1_800_000_000 },
    { status: "verified", email: "owner@example.invalid", localAdmin: true, exp: 1e12 }]) {
    const f = fixture(); f.setAuth(auth);
    await assert.rejects(f.authority.preview(f.request), /Owner verification required/);
    assert.equal(f.state().revision, 4);
  }
  const f = fixture(); const p = await f.authority.preview(f.request);
  f.setAuth({ status: "verified", subject: stranger, exp: 1e12 });
  await assert.rejects(f.authority.admit(p, admission(f, p)), /Owner verification required/);
});

test("policy grammar rejects unreviewed builds/offers, paid core/sync, extra authority and unsupported surfaces", async () => {
  const changes = [d => { d.builds[0].build = "*"; }, d => { d.builds[0].build = "synthetic-2"; },
    d => { d.builds[0].surface = "native_android"; }, d => { d.channels[0].offer = "unknown"; },
    d => { d.channels[0].channel = "direct_stripe"; }, d => { d.product.benefits = ["youtube.shorts"]; },
    d => { d.product.benefits = ["sync"]; }, d => { d.product.tier = "free"; },
    d => { d.environment = "production"; }, d => { d.url = "https://example.invalid"; },
    d => { d.cutoff = { activatedAt: 1 }; }, d => { d.schema = 2; }];
  for (const change of changes) {
    const f = fixture(); change(f.draft);
    await assert.rejects(f.authority.preview(f.request), /Invalid policy/);
  }
  for (const patch of [{ namespace: "rules" }, { environment: "production" }, { expectedRevision: 3 }, { expectedRevision: NaN }, { owner }]) {
    const f = fixture();
    await assert.rejects(f.authority.preview({ ...f.request, ...patch }));
  }
});

test("preview is detached and deeply immutable; changed draft cannot reuse its hash", async () => {
  const f = fixture(); const p = await f.authority.preview(f.request);
  const original = canonical(p);
  f.draft.channels[0].enabled = false;
  assert.equal(canonical(p), original);
  assert.throws(() => { p.draft.channels[0].enabled = false; }, TypeError);
  assert.throws(() => { p.after.channels.web = false; }, TypeError);
  await assert.rejects(f.authority.admit(p, admission(f, p)), /Preview changed/);
});

test("admission rejects stale revision/body/hash/id/source, expiry and clock rollback", async () => {
  for (const patch of [{ hash: "0".repeat(64) }, { operationId: stranger }, { expectedRevision: 3 },
    { namespace: "rating" }, { environment: "production" }]) {
    const f = fixture(); const p = await f.authority.preview(f.request);
    await assert.rejects(f.authority.admit(p, { ...admission(f, p), ...patch }));
  }
  for (const offset of [300_000, -1]) {
    const f = fixture(); const p = await f.authority.preview(f.request); f.setNow(f.now() + offset);
    await assert.rejects(f.authority.admit(p, admission(f, p)), /Preview expired/);
  }
  const f = fixture(); const p = await f.authority.preview(f.request);
  await assert.rejects(f.authority.admit({ ...p, sourceDigest: "c".repeat(64) }, admission(f, p)), /Unknown preview/);
  f.setState({ ...f.state(), revision: 5 });
  await assert.rejects(f.authority.admit(p, admission(f, p)), /Stale policy/);
});

test("existing synthetic cutoff is preserved and intervening changes invalidate preview", async () => {
  const f = fixture();
  const cutoff = { product: "synthetic-released-free", benefits: ["tiktok.all", "youtube.shorts"], activatedAt: 1000 };
  f.setState({ ...f.state(), cutoff });
  const p = await f.authority.preview(f.request);
  assert.deepEqual(p.cutoff, cutoff);
  assert.notEqual(p.cutoff, cutoff);
  cutoff.activatedAt = 2000;
  assert.equal(p.cutoff.activatedAt, 1000);
  await assert.rejects(f.authority.admit(p, admission(f, p)), /Stale policy/);
});

test("rating namespace starts Off and combines master, reviewed builds and fixed surfaces", async () => {
  const f = fixture();
  const draft = { schema: 1, environment: "sandbox", app: "still-app", master: false,
    surfaces: { ...surfaces, chrome_desktop: true, edge_desktop: true }, builds: f.draft.builds };
  const req = { ...f.request, namespace: "rating", draft };
  const off = await f.authority.preview(req);
  assert.deepEqual(off.before.surfaces, surfaces);
  assert.deepEqual(off.after.surfaces, surfaces);
  draft.master = true;
  const on = await f.authority.preview(req);
  assert.equal(on.after.surfaces.chrome_desktop, true);
  assert.equal(on.after.surfaces.edge_desktop, false); // No reviewed producer/build.
  assert.equal(await f.authority.admit(on, { ...req, operationId: on.operationId, hash: on.hash }), on);
  draft.surfaces.native_android = true;
  await assert.rejects(f.authority.preview(req), /Invalid policy/);
});
