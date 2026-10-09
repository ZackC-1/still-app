import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZip } from "../release/zip.mjs";
import {
  amoJwt, checkQaManifest, packageDirectory, QA_ADDON_ID, QA_ADDON_NAME, readCredentials, signWithAmo, verifySignedPayload, zipFiles, main,
} from "./firefox-qa-sign.mjs";

const QA_MANIFEST = { name: QA_ADDON_NAME, version: "3.1.0", browser_specific_settings: { gecko: { id: QA_ADDON_ID }, gecko_android: { strict_min_version: "142.0" } } };
const CREDENTIALS = { issuer: "user:12345:67", secret: "s".repeat(64) };

test("only the separate sandbox QA package passes the offline manifest check", () => {
  assert.deepEqual(checkQaManifest(QA_MANIFEST), { id: QA_ADDON_ID, version: "3.1.0" });
  const store = { ...QA_MANIFEST, browser_specific_settings: { ...QA_MANIFEST.browser_specific_settings, gecko: { id: "still@chartash.com" } } };
  assert.throws(() => checkQaManifest(store), /store add-on id/);
  assert.throws(() => checkQaManifest({ ...QA_MANIFEST, name: "Still: Remove Shorts & Reels, Stop Scrolling" }), /not the sandbox QA build/);
  assert.throws(() => checkQaManifest({ ...QA_MANIFEST, version: "3.1.0-qa" }), /version/);
  assert.throws(() => checkQaManifest({ ...QA_MANIFEST, browser_specific_settings: { gecko: { id: QA_ADDON_ID } } }), /Android/);
});

test("credentials must be a private file with exactly an AMO issuer and secret", () => {
  const file = (mode, value = CREDENTIALS, uid = 501) => ({
    lstat: () => ({ isFile: () => true, mode, uid }), readFile: () => JSON.stringify(value), uid: 501,
  });
  assert.deepEqual(readCredentials("/private/amo.json", file(0o100600)), CREDENTIALS);
  assert.throws(() => readCredentials(undefined), /STILL_QA_AMO_CREDENTIALS_FILE/);
  assert.throws(() => readCredentials("/x", file(0o100644)), /0600/);
  assert.throws(() => readCredentials("/x", { ...file(0o100600), lstat: () => ({ isFile: () => true, mode: 0o100600, uid: 0 }) }), /0600/);
  assert.throws(() => readCredentials("/x", file(0o100600, { ...CREDENTIALS, extra: "1" })), /exactly/);
  assert.throws(() => readCredentials("/x", file(0o100600, { issuer: "abc", secret: CREDENTIALS.secret })), /exactly/);
});

test("AMO JWT is HS256 with issuer, unique jti and at most five minutes of validity", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const [header, payload, signature] = amoJwt(CREDENTIALS, now).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "HS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, CREDENTIALS.issuer);
  assert.equal(claims.exp - claims.iat, 300);
  assert.equal(claims.iat, now / 1000);
  assert.notEqual(claims.jti, JSON.parse(Buffer.from(amoJwt(CREDENTIALS, now).split(".")[1], "base64url")).jti);
  assert.equal(signature, createHmac("sha256", CREDENTIALS.secret).update(`${header}.${payload}`).digest("base64url"));
});

/** A scripted AMO: records every call and serves the given responses in order. */
function fakeAmo(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body, auth: init.headers?.Authorization });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call ${init.method ?? "GET"} ${url}`);
    const { status = 200, json, bytes } = next;
    return { ok: status >= 200 && status < 300, status, json: async () => json, arrayBuffer: async () => bytes };
  };
  return { fetch, calls };
}
const PKG = { zip: Buffer.from("zip-bytes"), id: QA_ADDON_ID, version: "3.1.0" };
const FILE_URL = "https://addons.mozilla.org/api/v5/addons/file/1/still-qa.xpi";

test("signing uploads to the unlisted channel, creates the version by id and downloads the signed file", async () => {
  const amo = fakeAmo([
    { json: { uuid: "u-1" } },
    { json: { processed: false } },
    { json: { processed: true, valid: true, channel: "unlisted" } },
    { json: { version: { id: 99, channel: "unlisted" } } },
    { json: { file: { status: "unreviewed" } } },
    { json: { file: { status: "public", url: FILE_URL } } },
    { bytes: Buffer.from("signed") },
  ]);
  const result = await signWithAmo(PKG, CREDENTIALS, { fetch: amo.fetch, interval: 0 });
  assert.equal(result.signed.toString(), "signed");
  assert.equal(result.versionId, "99");
  assert.deepEqual(amo.calls.map(call => `${call.method} ${new URL(call.url).pathname}`), [
    "POST /api/v5/addons/upload/", "GET /api/v5/addons/upload/u-1/", "GET /api/v5/addons/upload/u-1/",
    "PUT /api/v5/addons/addon/still-qa-sandbox%40chartash.com/", "GET /api/v5/addons/addon/still-qa-sandbox%40chartash.com/versions/99/",
    "GET /api/v5/addons/addon/still-qa-sandbox%40chartash.com/versions/99/", "GET /api/v5/addons/file/1/still-qa.xpi",
  ]);
  assert.equal(amo.calls[0].body.get("channel"), "unlisted");
  assert.deepEqual(JSON.parse(amo.calls[3].body), { version: { upload: "u-1" } });
  assert.ok(amo.calls.every(call => call.auth.startsWith("JWT ")));
});

test("signing stops without retrying on a failed write, a non-unlisted result or a foreign download host", async () => {
  const validated = [{ json: { uuid: "u-1" } }, { json: { processed: true, valid: true } }];
  for (const [responses, pattern] of [
    [[{ status: 503 }], /HTTP 503; nothing was retried/],
    [[{ json: { uuid: "u-1" } }, { json: { processed: true, valid: false, validation: { messages: ["bad"] } } }], /validation failed/],
    [[{ json: { uuid: "u-1" } }, { json: { processed: true, valid: true, channel: "listed" } }], /other than unlisted/],
    [[...validated, { status: 500 }], /HTTP 500; nothing was retried/],
    [[...validated, { json: { version: { id: 5, channel: "listed" } } }], /outside the unlisted channel/],
    [[...validated, { json: { version: { id: 5 } } }, { json: { file: { status: "public", url: "https://example.org/x.xpi" } } }], /not on addons.mozilla.org/],
  ]) {
    const amo = fakeAmo([...responses]);
    await assert.rejects(signWithAmo(PKG, CREDENTIALS, { fetch: amo.fetch, interval: 0 }), pattern);
    assert.equal(amo.calls.filter(call => call.method !== "GET").length <= 2, true);
  }
  await assert.rejects(signWithAmo({ ...PKG, id: "still@chartash.com" }, CREDENTIALS, { fetch: fakeAmo([]).fetch }), /only the sandbox QA/);
});

test("the signed XPI must be the uploaded files plus a Mozilla signature", () => {
  const uploaded = [{ name: "manifest.json", sha256: "a" }, { name: "background.js", sha256: "b" }];
  const signature = [{ name: "META-INF/mozilla.rsa", sha256: "s" }, { name: "META-INF/manifest.mf", sha256: "m" }];
  assert.deepEqual(verifySignedPayload(uploaded, [...signature, ...uploaded]), ["META-INF/manifest.mf", "META-INF/mozilla.rsa"]);
  assert.throws(() => verifySignedPayload(uploaded, [...signature, uploaded[0], { name: "background.js", sha256: "changed" }]), /differ/);
  assert.throws(() => verifySignedPayload(uploaded, [...signature, ...uploaded, { name: "extra.js", sha256: "x" }]), /differ/);
  assert.throws(() => verifySignedPayload(uploaded, uploaded), /no Mozilla signature/);
});

test("a built QA directory packages deterministically and plan-only mode uploads nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "still-ff-qa-sign-"));
  try {
    const dir = join(root, "firefox-mv3");
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify(QA_MANIFEST));
    await writeFile(join(dir, "assets/background.js"), "worker");
    const first = packageDirectory(dir), second = packageDirectory(dir);
    assert.deepEqual(first.zip, second.zip);
    await writeFile(join(root, "signed.xpi"), createZip([
      { name: "META-INF/mozilla.rsa", data: Buffer.from("sig") },
      ...first.files.map(file => ({ name: file.name, data: Buffer.from(file.name === "manifest.json" ? JSON.stringify(QA_MANIFEST) : "worker") })),
    ]));
    assert.deepEqual(verifySignedPayload(first.files, zipFiles(join(root, "signed.xpi"))), ["META-INF/mozilla.rsa"]);
    const plan = await main([dir, join(root, "out")], {});
    assert.deepEqual([plan.addonId, plan.channel, plan.files], [QA_ADDON_ID, "unlisted", 2]);
    await assert.rejects(main([dir, join(root, "out"), "--submit"], {}), /STILL_QA_AMO_CREDENTIALS_FILE/);
    await assert.rejects(main([dir, join(root, "out"), "--upload"], {}), /usage/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
