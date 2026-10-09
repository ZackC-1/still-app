// Mozilla signing for the sandbox QA Firefox package (desktop and Android).
//
//   node scripts/qa/firefox-qa-sign.mjs <built firefox-mv3 dir> <output dir>            # check + plan only
//   node scripts/qa/firefox-qa-sign.mjs <built firefox-mv3 dir> <output dir> --submit   # sign through AMO
//
// The QA package has its own never-listed add-on id (packages/ext-chromium/wxt.config.ts
// QA_SANDBOX_PACKAGE). This signer only ever uses AMO's "unlisted" channel and refuses the store
// id, so it cannot upload through the public listing, where Continue can publish an update
// (docs/solutions/conventions/amo-continue-can-publish-an-update.md). Unlisted versions are signed
// for self-distribution and never appear on addons.mozilla.org.
//
// Credentials come only from the private JSON file named by STILL_QA_AMO_CREDENTIALS_FILE
// ({"issuer": "...", "secret": "..."}, mode 0600, owned by you). They are never read from arguments
// or printed. The call sequence follows Mozilla's web-ext 10.7.0 implementation of AMO API v5:
// upload, wait for validation, PUT the version under the add-on id, wait for the signed file,
// download it. A failed write is reported and never retried automatically: AMO version numbers are
// single-use, so an unknown outcome needs a person to look at the developer hub. Read-only status
// polls retry transient failures, and `--resume <version id>` downloads and verifies a version that
// was already created, without uploading anything.

import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "../release/zip.mjs";
import { treeEntries } from "../release/package.mjs";

export const QA_ADDON_ID = "still-qa-sandbox@chartash.com";
export const QA_ADDON_NAME = "Still QA Sandbox (not for release)";
export const STORE_ADDON_ID = "still@chartash.com";
export const AMO_API = "https://addons.mozilla.org/api/v5/addons/";
const CHANNEL = "unlisted";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const refusal = message => { throw new Error(`Firefox QA signing: ${message}`); };

/** Offline checks on the built package before anything leaves this machine. */
export function checkQaManifest(manifest) {
  const id = manifest?.browser_specific_settings?.gecko?.id;
  if (id === STORE_ADDON_ID) refusal("this is the store add-on id; only the separate QA package may be signed here");
  if (id !== QA_ADDON_ID || manifest.name !== QA_ADDON_NAME) refusal("package is not the sandbox QA build (wrong add-on id or name)");
  if (typeof manifest.version !== "string" || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) refusal("package version is missing or invalid");
  if (!manifest.browser_specific_settings.gecko_android) refusal("QA package must also install on Firefox for Android");
  return { id, version: manifest.version };
}

/** Private credentials: a regular 0600 file owned by the current user, with exactly two fields. */
export function readCredentials(path, { lstat = lstatSync, readFile = readFileSync, uid = process.getuid?.() } = {}) {
  if (!path) refusal("set STILL_QA_AMO_CREDENTIALS_FILE to your private AMO API key file");
  const stat = lstat(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid))
    refusal("credentials file must be a regular file you own with mode 0600");
  let value;
  try { value = JSON.parse(readFile(path, "utf8")); } catch { refusal("credentials file is not valid JSON"); }
  if (!value || Object.keys(value).sort().join(",") !== "issuer,secret" || typeof value.issuer !== "string" || typeof value.secret !== "string" ||
      !/^user:\d+:\d+$/.test(value.issuer) || value.secret.length < 32)
    refusal("credentials file must contain exactly an AMO issuer (user:…) and secret");
  return value;
}

/** AMO API v5 JWT: HS256, iss = issuer, unique jti, at most five minutes of validity. */
export function amoJwt({ issuer, secret }, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: issuer, jti: randomUUID(), iat, exp: iat + 300 })}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

/**
 * Mozilla's signer re-serializes manifest.json (layout only). A manifest entry therefore also
 * carries the SHA-256 of its parsed JSON with keys sorted, and only that file is compared that way.
 */
const sortKeys = value => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;
function fileEntry(name, data) {
  const entry = { name, sha256: sha256(data) };
  if (name !== "manifest.json") return entry;
  try { return { ...entry, jsonSha256: sha256(JSON.stringify(sortKeys(JSON.parse(data.toString("utf8"))))) }; }
  catch { return entry; }
}

/** Deterministic upload: the repository's fixed-timestamp, sorted zip of the built directory. */
export function packageDirectory(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const identity = checkQaManifest(manifest);
  const entries = treeEntries(dir);
  return { ...identity, zip: createZip(entries), files: entries.map(entry => fileEntry(entry.name, entry.data)) };
}

/**
 * The signed XPI must contain exactly the uploaded files plus Mozilla's META-INF signature entries.
 * Every file must be byte-identical except manifest.json, which must parse to the same JSON.
 */
export function verifySignedPayload(uploadedFiles, signedFiles) {
  const signature = signedFiles.filter(file => file.name.startsWith("META-INF/"));
  const payload = signedFiles.filter(file => !file.name.startsWith("META-INF/"));
  const identity = file => file.name === "manifest.json" && file.jsonSha256 ? `json:${file.jsonSha256}` : file.sha256;
  const key = files => JSON.stringify([...files].sort((a, b) => a.name.localeCompare(b.name)).map(file => [file.name, identity(file)]));
  if (key(payload) !== key(uploadedFiles)) refusal("signed XPI contents differ from the uploaded package");
  if (!signature.some(file => /^META-INF\/(mozilla\.rsa|cose\.sig)$/.test(file.name))) refusal("returned file has no Mozilla signature");
  return signature.map(file => file.name).sort();
}

const wait = ms => new Promise(done => setTimeout(done, ms));
async function poll(check, { interval, timeout, label, now = Date.now }) {
  const deadline = now() + timeout;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (now() >= deadline) refusal(`${label} did not finish in time; check the AMO developer hub before trying again`);
    await wait(interval);
  }
}

/** AMO calls. Writes are never retried; read-only polls retry transient failures a few times. */
function amoClient(credentials, { fetch = globalThis.fetch, api = AMO_API, interval = 3000 } = {}) {
  const request = async (path, { method = "GET", body } = {}) => {
    const headers = { Authorization: `JWT ${amoJwt(credentials)}`, Accept: "application/json" };
    if (typeof body === "string") headers["Content-Type"] = "application/json";
    return fetch(new URL(path, api), { method, headers, body });
  };
  const failed = (method, path, status) => refusal(`${method} ${new URL(path, api).pathname} returned HTTP ${status}; nothing was retried`);
  const gaveUp = (path, status) => refusal(`GET ${new URL(path, api).pathname} returned ${status} after 4 attempts; no write was repeated`);
  return {
    api,
    async write(path, method, body) {
      const response = await request(path, { method, body });
      if (!response.ok) failed(method, path, response.status);
      return response.json();
    },
    async read(path, { json = true } = {}) {
      for (let attempt = 1; ; attempt++) {
        let response;
        try { response = await request(path); } catch (error) { if (attempt >= 4) throw error; }
        if (response?.ok) return json ? response.json() : Buffer.from(await response.arrayBuffer());
        if (response && response.status !== 429 && response.status < 500) failed("GET", path, response.status);
        if (attempt >= 4) gaveUp(path, response ? `HTTP ${response.status}` : "a network error");
        await wait(interval);
      }
    },
  };
}

/** Upload, validate and create the unlisted version. Returns the AMO version id. Never retries a write. */
export async function submitToAmo({ zip, id, version }, client, { interval = 3000, timeout = 15 * 60_000 } = {}) {
  if (id !== QA_ADDON_ID) refusal("only the sandbox QA add-on id may be signed");
  const form = new FormData();
  form.set("channel", CHANNEL);
  form.set("upload", new File([zip], `still-qa-sandbox-${version}.zip`));
  const { uuid } = await client.write("upload/", "POST", form);
  if (typeof uuid !== "string" || !uuid) refusal("AMO returned no upload id");
  await poll(async () => {
    const detail = await client.read(`upload/${uuid}/`);
    if (!detail.processed) return undefined;
    if (!detail.valid) refusal(`AMO validation failed: ${JSON.stringify(detail.validation?.messages ?? detail.validation ?? {})}`);
    if (detail.channel !== CHANNEL) refusal("AMO did not record the upload as unlisted; nothing was submitted");
    return true;
  }, { interval, timeout, label: "Validation" });
  const created = await client.write(`addon/${encodeURIComponent(id)}/`, "PUT", JSON.stringify({ version: { upload: uuid } }));
  const versionId = created?.version?.id;
  if (!versionId) refusal("AMO did not return the new version; check the developer hub");
  if (created.version.channel !== CHANNEL) refusal("AMO created a version outside the unlisted channel; check the developer hub");
  return String(versionId);
}

/** Read-only: wait for Mozilla's signature on an existing version and download it. Used by --resume. */
export async function downloadSignedVersion(id, versionId, client, { interval = 3000, timeout = 15 * 60_000 } = {}) {
  if (id !== QA_ADDON_ID) refusal("only the sandbox QA add-on id may be signed");
  if (!/^\d+$/.test(String(versionId))) refusal("AMO version id must be a number");
  const fileUrl = await poll(async () => {
    const detail = await client.read(`addon/${encodeURIComponent(id)}/versions/${versionId}/`);
    if (detail?.channel !== CHANNEL) refusal("this AMO version is not reported as unlisted");
    if (detail?.file?.status === "disabled") refusal("Mozilla rejected this version; see the developer hub");
    return detail?.file?.status === "public" && detail.file.url ? detail.file.url : undefined;
  }, { interval, timeout, label: "Signing" });
  // The download carries the JWT, so it may only go to AMO itself.
  if (new URL(fileUrl).origin !== new URL(client.api).origin) refusal("signed file URL is not on addons.mozilla.org");
  return client.read(fileUrl, { json: false });
}

/** Upload, validate, create the unlisted version and download the signed XPI. Never retries a write. */
export async function signWithAmo(pkg, credentials, options = {}) {
  const client = amoClient(credentials, options);
  const versionId = await submitToAmo(pkg, client, options);
  return { signed: await downloadSignedVersion(pkg.id, versionId, client, options), versionId };
}

/** Keep the signed XPI only if it is the uploaded files plus Mozilla's signature. */
export function writeVerifiedXpi(pkg, signed, out, { listFiles = zipFiles } = {}) {
  const xpi = join(out, `still-qa-sandbox-${pkg.version}-signed.xpi`), pending = `${xpi}.unverified`;
  writeFileSync(pending, signed);
  try {
    const signatureFiles = verifySignedPayload(pkg.files, listFiles(pending));
    renameSync(pending, xpi);
    return { xpi, signatureFiles };
  } finally { rmSync(pending, { force: true }); }
}

/** Lists a zip's entries with SHA-256s using the system unzip tool (present on macOS and Linux). */
export function zipFiles(path) {
  const names = execFileSync("/usr/bin/unzip", ["-Z1", path], { encoding: "utf8" }).split("\n").filter(name => name && !name.endsWith("/"));
  return names.map(name => fileEntry(name, execFileSync("/usr/bin/unzip", ["-p", path, name], { maxBuffer: 64 * 1024 * 1024 })));
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [dir, out, flag, versionId, ...rest] = argv;
  const usage = "usage: firefox-qa-sign.mjs <built firefox-mv3 dir> <output dir> [--submit | --resume <AMO version id>]";
  if (!dir || !out || rest.length || (flag !== undefined && flag !== "--submit" && flag !== "--resume") ||
      (flag === "--resume") !== (versionId !== undefined)) refusal(usage);
  const pkg = packageDirectory(resolve(dir));
  const plan = { addonId: pkg.id, version: pkg.version, channel: CHANNEL, uploadSha256: sha256(pkg.zip), files: pkg.files.length };
  if (flag === undefined) {
    process.stdout.write(`Checked QA package ${pkg.id} ${pkg.version}; nothing uploaded. Plan: ${JSON.stringify(plan)}\n`);
    return plan;
  }
  const client = amoClient(readCredentials(env.STILL_QA_AMO_CREDENTIALS_FILE));
  mkdirSync(out, { recursive: true });
  const amoVersionId = flag === "--resume" ? String(versionId) : await submitToAmo(pkg, client);
  // Record the version before waiting, so a failed download can be resumed without the hub.
  writeFileSync(join(out, "amo-version.json"), `${JSON.stringify({ addonId: pkg.id, version: pkg.version, amoVersionId }, null, 2)}\n`);
  process.stdout.write(`AMO version ${amoVersionId} created or selected; resume with --resume ${amoVersionId} if the download fails.\n`);
  let signed;
  try { signed = await downloadSignedVersion(pkg.id, amoVersionId, client); }
  catch (error) { throw new Error(`${error.message} (AMO version ${amoVersionId}; retry the download with --resume ${amoVersionId})`, { cause: error }); }
  const { xpi, signatureFiles } = writeVerifiedXpi(pkg, signed, out);
  const receipt = { ...plan, amoVersionId, resumed: flag === "--resume", signedXpi: xpi, signedSha256: sha256(signed), signatureFiles, signedAt: new Date().toISOString() };
  writeFileSync(join(out, "signing-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`Signed ${pkg.id} ${pkg.version} (unlisted). XPI: ${xpi}\n`);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
