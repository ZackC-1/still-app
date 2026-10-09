import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm, lstat, chmod } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const PAID_FLAGS = Object.freeze({
  js: "packages/shared-types/src/entitlement.ts",
  native: "apps/apple/StillKit/Sources/StillKit/MonetizationConfig.swift",
});
const PAID_FALSE_NEEDLES = ["export const PAID_TIER_ENABLED = false;", "public static let paidTierEnabled = false"];
export function assertFreePaidFlags(files) {
  const originals = Object.values(PAID_FLAGS).map(path => files.find(file => file.path === path)?.bytes?.toString("utf8"));
  if (originals.some((text, i) => typeof text !== "string" || text.split(PAID_FALSE_NEEDLES[i]).length !== 2))
    refusal("both original paid constants must be exactly false");
}
const PLISTS = ["iOS (App)", "iOS (Extension)", "macOS (App)", "macOS (Extension)"].map(part => `apps/apple/Still/${part}/Info.plist`);
const REVIEWED_SIGNING_TEAM = "UM9HVDH3P3";
export const APPLE_TARGETS = Object.freeze({
  "apple-ios-sim": { scheme: "Still (iOS)", destination: "generic/platform=iOS Simulator", sdk: "iphonesimulator", signed: false, archive: false },
  "apple-macos": { scheme: "Still (macOS)", destination: "generic/platform=macOS", signed: false, archive: false },
  "apple-ios-archive": { scheme: "Still (iOS)", destination: "generic/platform=iOS", signed: true, archive: true },
  "apple-macos-archive": { scheme: "Still (macOS)", destination: "generic/platform=macOS", signed: true, archive: true },
  // Development-signed exports for the owner's registered QA devices. A device-limited profile
  // cannot be submitted to the App Store, and StoreKit in a development build uses the sandbox.
  "apple-ios-device": { scheme: "Still (iOS)", destination: "generic/platform=iOS", signed: true, archive: true, developmentExport: "Still.ipa" },
  "apple-macos-device": { scheme: "Still (macOS)", destination: "generic/platform=macOS", signed: true, archive: true, developmentExport: "Still.app" },
});
const APP_GROUP = "group.com.chartash.still";
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const refusal = message => { throw new Error(`Paid sandbox QA: ${message}`); };
const gitEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

/** Routing is a separate compiled choice from access-proof trust and backend hosting. */
export function backendRouteProfile(input, { requireSandbox = false } = {}) {
  const value = input.STILL_QA_BACKEND_ROUTE_PROFILE;
  if (value !== undefined && value !== "production" && value !== "shared-hosted-sandbox")
    throw new Error("QA backend route profile must be production or shared-hosted-sandbox");
  if (requireSandbox && value !== "shared-hosted-sandbox")
    throw new Error("Paid sandbox QA requires an explicit shared-hosted-sandbox backend route profile");
  return value ?? "production";
}

/** Same closed public-key grammar as packagedAccessTrust and NativeAccessConfiguration. */
export function sandboxConfiguration(input) {
  const routeProfile = backendRouteProfile(input, { requireSandbox: true });
  if (input.STILL_QA_BACKEND_ENVIRONMENT !== "shared-hosted") refusal("approved shared-hosted arrangement required");
  if (Object.keys(input).some(key => /^(STILL_QA_.*(?:PRIVATE|SECRET|TOKEN|PASSWORD|KEY_PATH)|ASC_)/.test(key)))
    refusal("private keys, tokens and signing credential inputs are forbidden");
  if (input.STILL_QA_ACCESS_ENVIRONMENT !== "sandbox") refusal("explicit sandbox access environment required");
  const text = input.STILL_QA_ACCESS_PUBLIC_KEYS;
  if (typeof text !== "string" || text.length > 16_384) refusal("sandbox public trust list required");
  let keys;
  try { keys = JSON.parse(text); } catch { refusal("invalid sandbox public trust list"); }
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 8) refusal("sandbox public trust list must contain one to eight keys");
  const seen = new Set();
  for (const key of keys) {
    if (!key || Array.isArray(key) || typeof key !== "object" || Object.keys(key).sort().join(",") !== "environment,kid,publicKeyHex,purpose" ||
      typeof key.kid !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(key.kid) || seen.has(key.kid) ||
      typeof key.publicKeyHex !== "string" || !/^[0-9a-f]{64}$/.test(key.publicKeyHex) || key.environment !== "sandbox" || key.purpose !== "access")
      refusal("invalid or mixed-environment sandbox public key");
    seen.add(key.kid);
  }
  let url;
  try { url = new URL(input.STILL_QA_SUPABASE_URL); } catch { refusal("hosted Supabase URL required"); }
  if (url.protocol !== "https:" || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    refusal("only the approved hosted Supabase HTTPS origin is allowed");
  const publicKey = input.STILL_QA_SUPABASE_ANON_KEY?.trim();
  if (typeof publicKey !== "string" || publicKey.length > 16_384) refusal("public Supabase client key required");
  if (publicKey.startsWith("sb_publishable_")) {
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publicKey) || publicKey.length > 1_024) refusal("invalid public publishable Supabase client key");
  } else {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(publicKey)) refusal("only a public anonymous Supabase client key is allowed");
    let claims;
    const payload = publicKey.split(".")[1];
    if (payload.length % 4 === 1) refusal("invalid public anonymous Supabase client key");
    try {
      const decoded = Buffer.from(payload, "base64url");
      if (decoded.length > 12_288) refusal("invalid public anonymous Supabase client key");
      claims = JSON.parse(decoded.toString());
    } catch { refusal("invalid public anonymous Supabase client key"); }
    if (claims.role !== "anon" || claims.ref !== url.hostname.split(".")[0]) refusal("public anonymous key must match the hosted project");
  }
  const revenueCatKey = input.STILL_QA_REVENUECAT_PUBLIC_API_KEY;
  if (typeof revenueCatKey !== "string" || revenueCatKey.length > 1_024 || !/^appl_[A-Za-z0-9_-]+$/.test(revenueCatKey))
    refusal("public Apple RevenueCat SDK key required");
  const publicKeys = keys.map(({ kid, publicKeyHex, environment, purpose }) => ({ kid, publicKeyHex, environment, purpose }));
  return { environment: "sandbox", backendRouteProfile: routeProfile, publicKeys, publicKeysJson: JSON.stringify(publicKeys), backendUrl: url.origin, publicKey, revenueCatKey,
    trustSha256: hash(JSON.stringify(publicKeys)), backendSha256: hash(url.origin), revenueCatKeySha256: hash(revenueCatKey) };
}

export async function sourceSnapshot(root, { includeIndexRemovedFiles = false } = {}) {
  const gitOptions = { cwd: root, encoding: "utf8", env: gitEnvironment() };
  // Git marks untracked nested repositories with a trailing slash; they are separate
  // workspaces, and neither Git clone nor this snapshot includes their contents.
  const present = new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], gitOptions).split("\0").filter(path => path && !path.endsWith("/")));
  // HEAD paths absent from the current index/untracked set must be removed from the clone.
  const head = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD"], gitOptions).split("\0").filter(Boolean);
  const paths = [...new Set([...present, ...head])].sort();
  const files = [], digest = createHash("sha256");
  for (const path of paths) {
    if (!path.endsWith("/.env.example") && path !== ".env.example" && /(^|\/)(\.env(?:\..*)?|[^/]*(?:private[-_]?key|credentials)[^/]*)$|\.(?:p8|pem|p12|key)$/i.test(path)) refusal("source snapshot contains a credential-file path");
    let bytes = null, executable = false;
    try { if (present.has(path) || includeIndexRemovedFiles) {
      const stat = await lstat(join(root, path));
      if (!stat.isFile()) refusal("source snapshot requires regular files");
      executable = Boolean(stat.mode & 0o111);
      bytes = await readFile(join(root, path));
    } } catch (error) { if (error.code !== "ENOENT") throw error; }
    // Hash entry boundaries and deletion state explicitly, including for binary sources.
    digest.update(JSON.stringify([path, bytes === null ? null : hash(bytes), executable])).update("\n");
    files.push({ path, bytes, executable });
  }
  return { files, sha256: digest.digest("hex"), revision: execFileSync("git", ["rev-parse", "HEAD"], gitOptions).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], gitOptions).trim()) };
}

const xml = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const valueXml = value => Array.isArray(value) ? `<array>${value.map(valueXml).join("")}</array>` : typeof value === "object" ? `<dict>${Object.entries(value).map(([key, v]) => `<key>${xml(key)}</key>${valueXml(v)}`).join("")}</dict>` : `<string>${xml(value)}</string>`;
export function plistConfiguration(config) {
  return { StillBackendRouteProfile: config.backendRouteProfile, StillAccessEnvironment: "sandbox", StillAccessTrustKeys: config.publicKeys,
    StillAccessSupabaseURL: config.backendUrl, StillAccessSupabasePublishableKey: config.publicKey };
}

/** Operates only on the freshly created clone. Original source is never edited, even on failure. */
export async function applySandboxOverlay(clone, config) {
  let marker;
  try { marker = JSON.parse(await readFile(join(dirname(clone), ".still-paid-sandbox-source"), "utf8")); } catch { refusal("overlay requires this runner's isolated source clone"); }
  if (marker.clone !== clone || marker.mode !== "paid-sandbox") refusal("overlay requires this runner's isolated source clone");
  const originals = await Promise.all(Object.values(PAID_FLAGS).map(path => readFile(join(clone, path), "utf8")));
  assertFreePaidFlags(Object.values(PAID_FLAGS).map((path, i) => ({ path, bytes: originals[i] })));
  const prepared = [];
  const before = new Map(Object.values(PAID_FLAGS).map((path, i) => [path, hash(originals[i])]));
  for (const [i, path] of Object.values(PAID_FLAGS).entries()) prepared.push([path, originals[i].replace(PAID_FALSE_NEEDLES[i], PAID_FALSE_NEEDLES[i].replace("false", "true"))]);
  const fields = plistConfiguration(config);
  for (const path of PLISTS) {
    let text = await readFile(join(clone, path), "utf8");
    before.set(path, hash(text));
    if (!/^<\?xml/.test(text) || !/<plist\b/.test(text) || !/<\/dict>\s*<\/plist>\s*$/.test(text)) refusal("expected XML native Info.plist");
    if (Object.keys(fields).some(key => text.includes(`<key>${key}</key>`))) refusal("native trust configuration must be empty before overlay");
    const nativeFields = { ...fields, ...(path.includes("(App)") ? { RevenueCatPublicAPIKey: config.revenueCatKey } : {}) };
    if (path.includes("(App)")) text = text.replace(/\s*<key>RevenueCatPublicAPIKey<\/key>\s*<string>[^<]*<\/string>/g, "");
    text = text.replace(/<\/dict>\s*<\/plist>\s*$/, `${Object.entries(nativeFields).map(([key, v]) => `<key>${key}</key>${valueXml(v)}`).join("\n")}\n</dict>\n</plist>\n`);
    prepared.push([path, text]);
  }
  for (const [path, text] of prepared) await writeFile(join(clone, path), text);
  return { mode: "paid-sandbox", flags: { jsPaid: true, nativePaid: true, modernSettingsSync: true, appleAtomicSettings: true },
    environment: "sandbox", backendRouteProfile: config.backendRouteProfile, trustSha256: config.trustSha256, backendSha256: config.backendSha256, revenueCatKeySha256: config.revenueCatKeySha256,
    products: { bundleId: "com.chartash.still", extensionBundleId: "com.chartash.still.Extension", current: "still_pro_v3", historical: "still_sync", offering: "still_pro_v3", package: "$rc_lifetime" },
    overlayFiles: prepared.map(([path, bytes]) => ({ path, beforeSha256: before.get(path), sha256: hash(bytes) })) };
}

export async function isolatedSandboxSource(root, config, operation) {
  const snapshot = await sourceSnapshot(root), run = await mkdtemp(join(tmpdir(), "still-paid-sandbox-")), clone = join(run, "source");
  try {
    execFileSync("git", ["clone", "--local", "--no-hardlinks", "--quiet", root, clone], { stdio: "pipe", env: gitEnvironment() });
    for (const file of snapshot.files) {
      const target = join(clone, file.path);
      if (file.bytes === null) await rm(target, { force: true });
      else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.bytes);
        await chmod(target, file.executable ? 0o755 : 0o644);
      }
    }
    if ((await sourceSnapshot(clone)).sha256 !== snapshot.sha256) refusal("isolated source differs from the reviewed snapshot");
    await writeFile(join(run, ".still-paid-sandbox-source"), JSON.stringify({ clone, mode: "paid-sandbox" }));
    const overlay = await applySandboxOverlay(clone, config);
    overlay.sourceOverlaySha256 = (await sourceSnapshot(clone)).sha256;
    overlay.overlaySha256 = hash(JSON.stringify(overlay.overlayFiles));
    const result = await operation({ clone, run, snapshot, overlay });
    await assertSandboxOverlay(clone, overlay);
    return result;
  } finally {
    await rm(run, { recursive: true, force: true });
    if ((await sourceSnapshot(root)).sha256 !== snapshot.sha256) refusal("original source changed during the isolated build; receipt refused");
  }
}

export async function assertSandboxOverlay(clone, overlay) {
  for (const file of overlay.overlayFiles) {
    if (hash(await readFile(join(clone, file.path))) !== file.sha256) refusal("paid flags/native configuration changed during build");
  }
}
export function assertPaidBuild(build) {
  if (!build || build.mode !== "paid-sandbox" || build.environment !== "sandbox" || build.backendRouteProfile !== "shared-hosted-sandbox" || build.flags?.jsPaid !== true || build.flags?.nativePaid !== true ||
    build.flags?.modernSettingsSync !== true || build.flags?.appleAtomicSettings !== true || !/^[a-f0-9]{64}$/.test(build.trustSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(build.sourceSha256 ?? "") || !Array.isArray(build.targets) || !build.targets.length) refusal("mixed or incomplete paid build identity");
}

/** Extract with the candidate's existing development parser in a separate, empty-env process.
 * Candidate dependencies never enter the verifier's realm or receive operator credentials. */
const INLINE_MODULE_EXTRACTOR = `
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const core = createRequire(join(process.argv[1], "packages/core/package.json"));
const parser = createRequire(core.resolve("jsdom")).resolve("parse5");
const { parse } = await import(pathToFileURL(parser).href);
const html = readFileSync(process.argv[2], "utf8");
if (Buffer.byteLength(html) > 8 * 1024 * 1024) throw new Error("HTML exceeds extraction bound");
const scripts = [];
const visit = node => {
  if (node.tagName === "template") return;
  if (node.tagName === "script" && node.namespaceURI === "http://www.w3.org/1999/xhtml" &&
      node.attrs.some(attr => attr.name === "type" && attr.value === "module") &&
      !node.attrs.some(attr => attr.name === "src")) {
    scripts.push(node.childNodes.filter(child => child.nodeName === "#text").map(child => child.value).join(""));
  }
  for (const child of node.childNodes ?? []) visit(child);
};
visit(parse(html, { scriptingEnabled: true }));
process.stdout.write(JSON.stringify(scripts));
`;

/** Establish key embedding in the executed webview entry or generated browser JavaScript.
 * Provider/device acceptance remains separate. Orphan webview chunks never satisfy the check. */
export async function assertCompiledSandboxTrust(artifact, config, {
  sourceRoot = fileURLToPath(new URL("../../../", import.meta.url)), inlineModules = false,
} = {}) {
  const { inventory } = await import("../../../scripts/qa/v3-profile.mjs");
  const files = (await inventory(artifact)).files;
  let scripts;
  if (inlineModules) {
    if (!files.some(file => file.path === "index.html")) refusal("generated JavaScript lacks the selected sandbox public trust");
    const result = runChecked(process.execPath, ["--input-type=module", "-e", INLINE_MODULE_EXTRACTOR,
      sourceRoot, join(artifact, "index.html")], { cwd: sourceRoot, env: {}, capture: true,
      maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
    try { scripts = JSON.parse(result); } catch { refusal("invalid inline module extraction"); }
    if (!Array.isArray(scripts) || scripts.length > 16 || scripts.some(text => typeof text !== "string") ||
        scripts.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) > 8 * 1024 * 1024)
      refusal("invalid inline module extraction");
  } else {
    scripts = await Promise.all(files.filter(file => /\.m?js$/.test(file.path)).map(file => readFile(join(artifact, file.path), "utf8")));
  }
  if (config.publicKeys.some(key => !scripts.some(text => text.includes(key.publicKeyHex))))
    refusal("generated JavaScript lacks the selected sandbox public trust");
}

export function runChecked(command, args, options = {}) {
  const { capture = false, ...spawnOptions } = options;
  const result = spawnSync(command, args, { ...spawnOptions, encoding: "utf8", stdio: capture ? "pipe" : (spawnOptions.stdio ?? ["ignore", "inherit", "inherit"]) });
  if (result.error || result.status !== 0) refusal(`local ${command.split("/").pop()} check failed; no success manifest issued`);
  return result.stdout;
}
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const readPlist = path => JSON.parse(runChecked("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], { capture: true }));
export function assertNativePlist(plist, bundleId, config) {
  if (plist.CFBundleIdentifier !== bundleId || Object.entries(plistConfiguration(config)).some(([key, value]) => stable(plist[key]) !== stable(value)))
    refusal("packaged native app/extension trust or identity mismatch");
  if (bundleId === "com.chartash.still" && plist.RevenueCatPublicAPIKey !== config.revenueCatKey)
    refusal("packaged native SDK public key mismatch");
}
export async function verifyApplePackage(app, target, config, clone) {
  const mac = target.includes("macos"), resources = mac ? join(app, "Contents/Resources") : app;
  const plugins = mac ? join(app, "Contents/PlugIns") : join(app, "PlugIns");
  const extension = join(plugins, "Still Extension.appex");
  let signingTeam;
  if (APPLE_TARGETS[target].signed) {
    const project = await readFile(join(clone, "apps/apple/Still/Still.xcodeproj/project.pbxproj"), "utf8");
    const teams = new Set([...project.matchAll(/\bDEVELOPMENT_TEAM\s*=\s*([A-Z0-9]{10})\s*;/g)].map(match => match[1]));
    if (teams.size !== 1 || !teams.has(REVIEWED_SIGNING_TEAM)) refusal("archive requires the reviewed Apple signing team");
    signingTeam = REVIEWED_SIGNING_TEAM;
  }
  for (const [bundle, id] of [[app, "com.chartash.still"], [extension, "com.chartash.still.Extension"]]) {
    const plist = readPlist(join(bundle, mac ? "Contents/Info.plist" : "Info.plist"));
    assertNativePlist(plist, id, config);
    if (signingTeam) runChecked("/usr/bin/codesign", ["--verify", "--deep", "--strict", `-R=anchor apple generic and certificate leaf[subject.OU] = "${signingTeam}"`, bundle]);
  }
  const web = await readFile(join(clone, "packages/app-webview/dist/index.html"));
  // Compare every generated Safari resource, including worker/content scripts and manifest.
  const { inventory } = await import("../../../scripts/qa/v3-profile.mjs");
  const expectedWeb = await inventory(join(clone, "packages/app-webview/dist"));
  const packagedWeb = await inventory(join(resources, "WebUI"));
  const webFiles = files => files.filter(file => file.path !== ".env-state");
  if (JSON.stringify(webFiles(expectedWeb.files)) !== JSON.stringify(webFiles(packagedWeb.files))) refusal("packaged webview differs from current candidate build");
  const safari = await inventory(join(clone, "packages/ext-safari/dist/safari-mv3"));
  const packagedSafari = await inventory(join(extension, mac ? "Contents/Resources" : ""));
  // Native entries observed in real Xcode products are outside the generated web resource set.
  const nativeFiles = new Set(mac ? ["PrivacyInfo.xcprivacy"] : ["Info.plist", "PrivacyInfo.xcprivacy",
    "Still Extension", "Still Extension.debug.dylib", "__preview.dylib", "embedded.mobileprovision"]);
  const packagedFiles = packagedSafari.files.filter(file => !nativeFiles.has(file.path) && !(file.path.startsWith("_CodeSignature/") && !mac));
  if (JSON.stringify(safari.files) !== JSON.stringify(packagedFiles)) refusal("packaged Safari resources differ from current candidate build");
  return { nativeInfoPlistsMatched: true, nativeBackendRouteProfileMatched: true, webviewSha256: hash(web), safari, codeSigned: APPLE_TARGETS[target].signed, ...(signingTeam ? { signingTeam } : {}) };
}

/** Export options for registered QA devices: development method, local export only, no upload.
 * The caller never passes -allowProvisioningUpdates, so only existing local profiles are used. */
export function developmentExportOptions() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>debugging</string>
<key>teamID</key><string>${REVIEWED_SIGNING_TEAM}</string>
<key>signingStyle</key><string>automatic</string>
<key>destination</key><string>export</string>
</dict></plist>
`;
}

const plistKey = (path, key, format) => {
  const result = spawnSync("/usr/bin/plutil", ["-extract", key, format, "-o", "-", path], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};
/** Decoded embedded provisioning profile fields; dates are not JSON, so each field is extracted. */
export function readEmbeddedProfile(bundle, mac) {
  const embedded = mac ? join(bundle, "Contents/embedded.provisionprofile") : join(bundle, "embedded.mobileprovision");
  // Decode outside the signed bundle so nothing unsealed is ever written into it.
  const scratch = mkdtempSync(join(tmpdir(), "still-profile-")), decoded = join(scratch, "profile.plist");
  try {
    runChecked("/usr/bin/security", ["cms", "-D", "-i", embedded, "-o", decoded]);
    const json = key => { const text = plistKey(decoded, key, "json"); return text === undefined ? undefined : JSON.parse(text); };
    return { teams: json("TeamIdentifier"), devices: json("ProvisionedDevices"), allDevices: plistKey(decoded, "ProvisionsAllDevices", "raw") === "true",
      expires: plistKey(decoded, "ExpirationDate", "raw"), entitlements: json("Entitlements") };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
export function readSignedEntitlements(bundle) {
  const xmlText = runChecked("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", bundle], { capture: true });
  const parsed = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: xmlText, encoding: "utf8" });
  if (parsed.status !== 0) refusal("unreadable signed entitlements");
  return JSON.parse(parsed.stdout);
}

/** Device-limited development signing for the reviewed team, with the shared App Group in both
 * bundles. Records counts and dates only; device identifiers never enter a receipt. */
export function verifyDevelopmentSigning(app, target, { readProfile = readEmbeddedProfile, readEntitlements = readSignedEntitlements, now = Date.now() } = {}) {
  if (!APPLE_TARGETS[target]?.developmentExport) refusal("not a development device target");
  const mac = target.includes("macos");
  const extension = join(app, mac ? "Contents/PlugIns" : "PlugIns", "Still Extension.appex");
  const bundles = [];
  for (const [bundle, id] of [[app, "com.chartash.still"], [extension, "com.chartash.still.Extension"]]) {
    const profile = readProfile(bundle, mac), signed = readEntitlements(bundle);
    const identifier = profile.entitlements?.["application-identifier"] ?? profile.entitlements?.["com.apple.application-identifier"];
    const expires = Date.parse(profile.expires ?? "");
    if (JSON.stringify(profile.teams) !== JSON.stringify([REVIEWED_SIGNING_TEAM]) || identifier !== `${REVIEWED_SIGNING_TEAM}.${id}`)
      refusal("development profile is not the reviewed team's profile for this bundle");
    if (!Array.isArray(profile.devices) || profile.devices.length < 1 || profile.allDevices)
      refusal("development package requires a device-limited profile; store or enterprise profiles are refused");
    if (!Number.isFinite(expires) || expires <= now) refusal("development profile is expired or undated");
    if (!signed["com.apple.security.application-groups"]?.includes(APP_GROUP)) refusal("signed bundle lacks the shared App Group");
    bundles.push({ bundleId: id, provisionedDeviceCount: profile.devices.length, profileExpires: new Date(expires).toISOString() });
  }
  return { developmentSigned: true, appGroup: APP_GROUP, bundles };
}

export async function buildAppleTarget({ clone, output, target, env, config }) {
  const spec = APPLE_TARGETS[target];
  if (!spec) refusal("unknown Apple target");
  await mkdir(output, { recursive: true });
  for (const pkg of ["app-webview", "ext-safari"]) runChecked("pnpm", ["--filter", `@still/${pkg}`, "build"], { cwd: clone, env });
  runChecked("bash", [join(clone, "apps/apple/scripts/release-env-guard.sh"), join(clone, "packages/app-webview"), join(clone, "packages/ext-safari"), join(clone, "apps/apple/scripts/modern-sync-shipped"), join(clone, "packages/app-webview/dist/.env-state")], { cwd: clone, env });
  const archive = join(output, "Still.xcarchive"), derived = join(output, "DerivedData");
  const args = [spec.archive ? "archive" : "build", "-project", join(clone, "apps/apple/Still/Still.xcodeproj"), "-scheme", spec.scheme,
    "-configuration", "Release", "-destination", spec.destination, "-derivedDataPath", derived];
  if (spec.sdk) args.push("-sdk", spec.sdk);
  if (spec.archive) args.push("-archivePath", archive);
  else args.push("CODE_SIGNING_ALLOWED=NO");
  runChecked("xcodebuild", args, { cwd: clone, env });
  const artifact = join(output, "artifact"); await mkdir(artifact, { recursive: true });
  if (spec.developmentExport) {
    const options = join(output, "ExportOptions.plist"), exported = join(output, "export");
    // A refused package, its archive and its export are removed on every exit, never left installable.
    try {
      await writeFile(options, developmentExportOptions());
      runChecked("xcodebuild", ["-exportArchive", "-archivePath", archive, "-exportPath", exported, "-exportOptionsPlist", options], { cwd: clone, env });
      let app = join(exported, "Still.app");
      if (spec.developmentExport === "Still.ipa") {
        runChecked("/usr/bin/ditto", ["-x", "-k", join(exported, "Still.ipa"), join(output, "ipa")]);
        app = join(output, "ipa/Payload/Still.app");
      }
      const verified = { ...(await verifyApplePackage(app, target, config, clone)), ...verifyDevelopmentSigning(app, target) };
      // Re-check the exact bundle immediately before packaging it.
      runChecked("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
      // ditto keeps the Mac bundle's signature intact; the exported IPA is already an archive.
      if (spec.developmentExport === "Still.ipa") runChecked("/bin/cp", [join(exported, "Still.ipa"), join(artifact, "Still.ipa")]);
      else runChecked("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, join(artifact, "Still-mac.zip")]);
      return verified;
    } catch (error) {
      await rm(artifact, { recursive: true, force: true });
      throw error;
    } finally {
      for (const path of [derived, archive, exported, join(output, "ipa"), options]) await rm(path, { recursive: true, force: true });
    }
  }
  const app = spec.archive ? join(archive, "Products/Applications/Still.app") : join(derived, "Build/Products", target === "apple-ios-sim" ? "Release-iphonesimulator" : "Release", "Still.app");
  const verified = await verifyApplePackage(app, target, config, clone);
  runChecked("tar", ["-czf", join(artifact, "Still.tgz"), "-C", dirname(spec.archive ? archive : app), spec.archive ? "Still.xcarchive" : "Still.app"]);
  await rm(derived, { recursive: true, force: true });
  if (spec.archive) await rm(archive, { recursive: true, force: true });
  return verified;
}

export async function requireIntegratedPaidCandidate(root) {
  for (const path of ["packages/core/src/entitlement/packaged-access-trust.ts", "apps/apple/StillKit/Sources/StillKit/NativeAccessConfiguration.swift"])
    try { await readFile(join(root, path)); } catch { refusal("integrated packaged/native access trust wiring is missing; this base is not a paid QA candidate"); }
  // Source presence is a prerequisite, not proof that generated clients consume the profile.
  try { await readFile(join(root, "packages/core/src/sync/backend-route-profile.ts")); }
  catch { refusal("integrated backend route profile source is missing; this base is not a complete paid QA candidate"); }
  const native = await readFile(join(root, "apps/apple/StillKit/Sources/StillKit/NativeAccessConfiguration.swift"), "utf8");
  if (!native.includes("StillBackendRouteProfile"))
    refusal("integrated native backend route profile source is missing; this base is not a complete paid QA candidate");
  const catalog = await readFile(join(root, "apps/apple/StillKit/Sources/StillKit/ApplePurchaseCatalog.swift"), "utf8");
  if (!/public static let stillProV3 = ApplePurchaseProduct\([\s\S]*?productID: "still_pro_v3",[\s\S]*?entitlementID: "still_pro_v3",[\s\S]*?offeringID: "still_pro_v3",[\s\S]*?packageID: "\$rc_lifetime"/.test(catalog) || !/public static let historicalStillSync = ApplePurchaseProduct\([\s\S]*?productID: "still_sync"/.test(catalog)) refusal("canonical Apple purchase mapping missing");
}

export function candidateIdentity(snapshot, overlay, targets) {
  const data = { ...overlay, sourceSha256: snapshot.sha256, targets, buildId: randomUUID() };
  assertPaidBuild(data);
  return { ...data, candidateSha256: hash(JSON.stringify(data)) };
}
