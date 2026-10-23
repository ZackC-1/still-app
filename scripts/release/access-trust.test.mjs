import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  APPLE_PLISTS,
  appleProductionConfig,
  PRODUCTION_SUPABASE_ORIGIN,
  PRODUCTION_SUPABASE_REF,
  applyApplePlists,
  assertServerGate,
  PAID_FLAGS,
  paidFlagValue,
  parseServerDigests,
  TEST_ONLY_FIXTURE_PUBLIC_KEYS,
  applyStoreTrustToPlist,
  compareServerDigests,
  MAX_TRUST_KEYS,
  paidDeclared,
  parseStoreTrust,
  plistTrustFields,
  readStoreTrust,
  restoreApplePlists,
  sha256,
  TEST_ONLY_TRUST_FIXTURE,
  TRUST_FILE,
} from "./access-trust.mjs";
import { ROOT } from "./version.mjs";

/** A fresh Ed25519 public key; the private half is never exported or kept. */
const freshPublicKeyHex = () => generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const row = (kid, extra = {}) => ({ kid, publicKeyHex: freshPublicKeyHex(), environment: "production", purpose: "access", ...extra });
const file = (keys, about = "public keys") => JSON.stringify({ about, keys });
const fixture = () => JSON.parse(readFileSync(join(ROOT, TEST_ONLY_TRUST_FIXTURE), "utf8"));
const appleEnv = { VITE_SUPABASE_URL: PRODUCTION_SUPABASE_ORIGIN, VITE_SUPABASE_ANON_KEY: "sb_publishable_synthetic_public" };

/** A scratch root holding just what the trust code reads. */
function scratchRoot(keys) {
  const root = mkdtempSync(join(tmpdir(), "still-trust-"));
  for (const path of [...APPLE_PLISTS, TEST_ONLY_TRUST_FIXTURE, "packages/shared-types/src/entitlement.ts", "apps/apple/StillKit/Sources/StillKit/MonetizationConfig.swift"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(ROOT, path), join(root, path));
  }
  mkdirSync(dirname(join(root, TRUST_FILE)), { recursive: true });
  writeFileSync(join(root, TRUST_FILE), file(keys));
  return root;
}

/** The scratch root with both paid constants written off (the committed 3.x tree declares them on). */
function paidOff(root) {
  const flags = [
    ["packages/shared-types/src/entitlement.ts", "export const PAID_TIER_ENABLED = true;", "export const PAID_TIER_ENABLED = false;"],
    ["apps/apple/StillKit/Sources/StillKit/MonetizationConfig.swift", "public static let paidTierEnabled = true", "public static let paidTierEnabled = false"],
  ];
  for (const [path, on, off] of flags) writeFileSync(join(root, path), readFileSync(join(root, path), "utf8").replace(on, off));
  return root;
}

test("the committed pinned file passes the store rules", () => {
  const trust = readStoreTrust(ROOT);
  assert.ok(trust.rows.length <= MAX_TRUST_KEYS);
  assert.ok(trust.rows.every((r) => r.environment === "production" && r.purpose === "access"));
  assert.deepEqual(trust.env, { VITE_ACCESS_ENVIRONMENT: "production", VITE_ACCESS_PUBLIC_KEYS: trust.json });
  assert.equal(trust.sha256, sha256(trust.json));
});

test("a current and a standby production key are accepted, normalized and frozen", () => {
  const keys = [row("still-access-2026-10"), row("still-access-standby")];
  const rows = parseStoreTrust(file(keys.map((k) => ({ purpose: k.purpose, environment: k.environment, publicKeyHex: k.publicKeyHex, kid: k.kid }))));
  assert.deepEqual(rows, keys);
  assert.deepEqual(Object.keys(rows[0]), ["kid", "publicKeyHex", "environment", "purpose"]);
  assert.ok(Object.isFrozen(rows) && Object.isFrozen(rows[0]));
  assert.deepEqual(parseStoreTrust(file(keys), { paid: true }), keys);
});

test("a store build refuses any row that is not production", () => {
  for (const environment of ["sandbox", "Production", "", undefined])
    assert.throws(() => parseStoreTrust(file([row("still-access", { environment })])), /environment|exactly kid/);
  assert.throws(() => parseStoreTrust(file([row("still-access"), row("still-qa", { environment: "sandbox" })])), /accepts only production keys/);
});

test("a store build refuses malformed, extra, duplicate or too many rows", () => {
  const good = row("still-access");
  for (const bad of [
    [{ ...good, privateKeyPkcs8Base64: "x" }],
    [{ ...good, purpose: "rules" }],
    [{ ...good, publicKeyHex: good.publicKeyHex.toUpperCase() }],
    [{ ...good, publicKeyHex: "ab" }],
    [{ ...good, kid: "../x" }],
    [good, { ...good }],
    [good, { ...row("other"), publicKeyHex: good.publicKeyHex }],
    [row("a"), row("b"), row("c")],
  ])
    assert.throws(() => parseStoreTrust(file(bad)), /store access trust/);
  for (const text of ["not json", "[]", JSON.stringify({ keys: [] }), JSON.stringify({ about: "x", keys: [], extra: 1 }), JSON.stringify({ about: 1, keys: [] })])
    assert.throws(() => parseStoreTrust(text), /store access trust/);
});

test("the TEST-ONLY fixture is production-shaped but every store build refuses it", () => {
  const { about, keys } = fixture();
  assert.match(about, /TEST ONLY\. NOT THE REAL PRODUCTION KEYS/);
  assert.equal(keys.length, 2);
  assert.ok(keys.every((k) => k.environment === "production" && k.purpose === "access" && k.kid.startsWith("test-only")));
  assert.throws(() => parseStoreTrust(file(keys)), /TEST-ONLY fixture key/);
  // Renaming the kid does not get a fixture key past the guard.
  assert.throws(() => parseStoreTrust(file([{ ...keys[0], kid: "still-access" }])), /TEST-ONLY fixture key/);
  assert.throws(() => parseStoreTrust(file([row("test-only-anything")])), /TEST-ONLY fixture key/);
  // The fixture values are hardcoded too, so an unreadable fixture file cannot let them through.
  assert.deepEqual([...TEST_ONLY_FIXTURE_PUBLIC_KEYS], keys.map((k) => k.publicKeyHex));
  assert.throws(() => parseStoreTrust(file([{ ...keys[1], kid: "still-access" }]), { testOnlyKeys: [] }), /TEST-ONLY fixture key/);
});

test("once the release declares the paid tier, an empty key list is refused", () => {
  assert.deepEqual(parseStoreTrust(file([])), []);
  assert.throws(() => parseStoreTrust(file([]), { paid: true }), /declares the paid tier/);
});

test("paid is declared by either paid constant in the source (PR-B adds the release-line hook)", () => {
  const root = paidOff(scratchRoot([]));
  try {
    assert.equal(paidDeclared(root), false);
    assert.equal(readStoreTrust(root).paid, false);
    const js = join(root, "packages/shared-types/src/entitlement.ts");
    const jsOff = readFileSync(js, "utf8");
    writeFileSync(js, jsOff.replace("export const PAID_TIER_ENABLED = false;", "export const PAID_TIER_ENABLED = true;"));
    assert.equal(paidDeclared(root), true);
    assert.throws(() => readStoreTrust(root), /declares the paid tier/);
    writeFileSync(js, jsOff);
    assert.equal(paidDeclared(root), false);
    const native = join(root, "apps/apple/StillKit/Sources/StillKit/MonetizationConfig.swift");
    writeFileSync(native, readFileSync(native, "utf8").replace("public static let paidTierEnabled = false", "public static let paidTierEnabled = true"));
    assert.equal(paidDeclared(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reworded, missing or repeated paid declaration refuses instead of reading as free", () => {
  const [js, swift] = PAID_FLAGS;
  assert.equal(paidFlagValue(js, "export const PAID_TIER_ENABLED: boolean = true;"), true);
  assert.equal(paidFlagValue(js, "export const PAID_TIER_ENABLED : boolean=false ;"), false);
  assert.equal(paidFlagValue(swift, "  public static let paidTierEnabled: Bool = true\n"), true);
  assert.equal(paidFlagValue(swift, "public static let paidTierEnabled = false // note"), false);
  for (const [flag, text] of [
    [js, "export const PAID_TIER_ENABLED = isPaid();"],
    [js, "export let PAID_TIER_ENABLED = true;"],
    [js, ""],
    [js, "export const PAID_TIER_ENABLED = false;\nexport const PAID_TIER_ENABLED = true;"],
    [swift, "public static let paidTierEnabled = trueish"],
    [swift, "public static var paidTierEnabled = true"],
    [swift, "public static let paidTierEnabled: Bool = Bool(\"true\")!"],
    [swift, "public static let paidTierEnabled = false || true"],
    [swift, "public static let paidTierEnabled = true && false"],
    [swift, "public static let paidTierEnabled = false; otherExpression()"],
    [swift, "public static let paidTierEnabled = false\n || true"],
    [swift, "public static let paidTierEnabled = false // continued\n // comment\n || true"],
  ])
    assert.throws(() => paidFlagValue(flag, text), /exactly one paid-tier declaration|exact Boolean initializer/, text);
  const root = scratchRoot([]);
  try {
    rmSync(join(root, swift.path));
    assert.throws(() => paidDeclared(root), /cannot read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the release gate: a paid release needs server digests that match a pinned key", () => {
  const rows = parseStoreTrust(file([row("still-access-a"), row("still-access-b")]));
  const digests = (publicKeyHex, kid, environment = "production") => [
    { name: "ACCESS_PROOF_ENVIRONMENT", value: sha256(environment) },
    { name: "ACCESS_PROOF_KEY_ID", value: sha256(kid) },
    { name: "ACCESS_PROOF_PUBLIC_KEY_HEX", value: sha256(publicKeyHex) },
  ];
  const paid = { rows, paid: true };
  assert.equal(assertServerGate({ rows: [], paid: false }, undefined), null);
  assert.throws(() => assertServerGate(paid, undefined), /needs the server's secret digests/);
  assert.equal(assertServerGate(paid, digests(rows[0].publicKeyHex, rows[0].kid)).signingRow, "current");
  assert.equal(assertServerGate(paid, digests(rows[1].publicKeyHex, rows[1].kid)).signingRow, "standby");
  // A private seed pinned in place of the public key is also 32 bytes of hex; the server's real public
  // key never matches it, so the gate refuses.
  const pinnedSeed = { rows: parseStoreTrust(file([row("still-access-a")])), paid: true };
  assert.throws(() => assertServerGate(pinnedSeed, digests(rows[0].publicKeyHex, "still-access-a")), /PUBLIC half/);
  assert.throws(() => assertServerGate(paid, digests(rows[0].publicKeyHex, rows[0].kid, "sandbox")), /server-environment-is-production/);
  assert.throws(() => assertServerGate({ rows, paid: false }, digests(freshPublicKeyHex(), "x")), /does not match/);
});

test("server digests: only the three public-side entries are kept, and a non-JSON file is never echoed", () => {
  const list = parseServerDigests(JSON.stringify([
    { name: "ACCESS_PROOF_PUBLIC_KEY_HEX", value: "aa" },
    { name: "ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64", value: "bb" },
    { name: "OTHER", digest: "cc" },
    { name: "ACCESS_PROOF_KEY_ID", digest: "dd" },
  ]));
  assert.deepEqual(list, [{ name: "ACCESS_PROOF_PUBLIC_KEY_HEX", value: "aa" }, { name: "ACCESS_PROOF_KEY_ID", value: "dd" }]);
  const marker = ["LEAK", "CANARY"].join("_");
  for (const text of [`API_KEY=${marker}\n`, `{"a": "${marker}"`, JSON.stringify({ marker })])
    assert.throws(() => parseServerDigests(text), (error) => /is not the JSON list/.test(error.message) && !error.message.includes(marker));
  const dir = mkdtempSync(join(tmpdir(), "still-digests-"));
  try {
    writeFileSync(join(dir, ".env"), `ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64=${marker}\n`);
    const run = spawnSync(process.execPath, [join(ROOT, "scripts/release/access-trust.mjs"), "compare-server", "--secrets-json", join(dir, ".env")], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.ok(!run.stderr.includes(marker) && !run.stdout.includes(marker), "no file content in the output");
    assert.match(run.stderr, /is not the JSON list/);
    const missing = spawnSync(process.execPath, [join(ROOT, "scripts/release/access-trust.mjs"), "check", "--server-secrets-json", join(dir, "nope.json")], { encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /cannot read the server digest file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the plist writer adds exactly the production fields, and plutil reads them back", () => {
  const rows = parseStoreTrust(file([row("still-access-a"), row("still-access-b")]));
  const dir = mkdtempSync(join(tmpdir(), "still-plist-"));
  try {
    for (const path of APPLE_PLISTS) {
      const original = readFileSync(join(ROOT, path), "utf8");
      const next = applyStoreTrustToPlist(original, rows, appleEnv);
      assert.ok(next.startsWith(original.replace(/<\/dict>\s*<\/plist>\s*$/, "")), "only appends before the closing dict");
      assert.throws(() => applyStoreTrustToPlist(next, rows), /already carries/);
      if (process.platform === "darwin") {
        const out = join(dir, "Info.plist");
        writeFileSync(out, next);
        const parsed = spawnSync("plutil", ["-convert", "json", "-o", "-", out], { encoding: "utf8" });
        assert.equal(parsed.status, 0, parsed.stderr);
        const json = JSON.parse(parsed.stdout);
        const fields = plistTrustFields(rows, appleEnv);
        assert.deepEqual(Object.fromEntries(Object.keys(fields).map((key) => [key, json[key]])), fields);
        const before = JSON.parse(spawnSync("plutil", ["-convert", "json", "-o", "-", join(ROOT, path)], { encoding: "utf8" }).stdout);
        for (const key of Object.keys(fields)) delete json[key];
        assert.deepEqual(json, before, `${path}: nothing else changes`);
      }
    }
    assert.throws(() => applyStoreTrustToPlist(readFileSync(join(ROOT, APPLE_PLISTS[0]), "utf8"), []), /no keys/);
    assert.throws(() => applyStoreTrustToPlist("{}", rows), /XML Info\.plist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apple-apply writes the four plists for the archive and apple-restore puts back the exact bytes", () => {
  const root = scratchRoot([row("still-access-a"), row("still-access-b")]);
  const backup = join(root, "backup");
  try {
    const originals = APPLE_PLISTS.map((path) => readFileSync(join(root, path)));
    const applied = applyApplePlists(root, backup, { env: appleEnv });
    assert.deepEqual(applied.kids, ["still-access-a", "still-access-b"]);
    for (const path of APPLE_PLISTS) assert.match(readFileSync(join(root, path), "utf8"), /<key>StillAccessEnvironment<\/key><string>production<\/string>\n<key>StillAccessTrustKeys<\/key><array><dict><key>kid<\/key><string>still-access-a<\/string>/);
    assert.throws(() => applyApplePlists(root, backup), /already holds a backup/);
    assert.equal(restoreApplePlists(root, backup), true);
    APPLE_PLISTS.forEach((path, i) => assert.ok(readFileSync(join(root, path)).equals(originals[i]), `${path} restored exactly`));
    assert.equal(restoreApplePlists(root, join(root, "no-backup")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native public configuration refuses missing, foreign or privileged inputs without echoing values", () => {
  const jwt = (payload, alg = "HS256") => [
    Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"), "synthetic_signature",
  ].join(".");
  const anon = jwt({ role: "anon", ref: PRODUCTION_SUPABASE_REF });
  assert.deepEqual(appleProductionConfig(appleEnv), { origin: PRODUCTION_SUPABASE_ORIGIN, publicKey: appleEnv.VITE_SUPABASE_ANON_KEY });
  assert.equal(appleProductionConfig({ ...appleEnv, VITE_SUPABASE_URL: `${PRODUCTION_SUPABASE_ORIGIN}/`, VITE_SUPABASE_ANON_KEY: anon }).publicKey, anon);
  for (const env of [
    {}, { VITE_SUPABASE_URL: PRODUCTION_SUPABASE_ORIGIN },
    { ...appleEnv, VITE_BACKEND_ROUTE_PROFILE: "shared-hosted-sandbox" },
    ...["https://qa.example", `${PRODUCTION_SUPABASE_ORIGIN}/path`, `${PRODUCTION_SUPABASE_ORIGIN}?x=1`, `${PRODUCTION_SUPABASE_ORIGIN}#fragment`, "http://kikpgrreradotvvefdgd.supabase.co"].map((VITE_SUPABASE_URL) => ({ ...appleEnv, VITE_SUPABASE_URL })),
    ...["sb_secret_LEAK_CANARY", "sb_publishable_", `${anon}\n`, "not-a-key", jwt({ role: "service_role", ref: PRODUCTION_SUPABASE_REF }), jwt({ role: "anon", ref: "other-project" }), jwt({ role: "anon", ref: PRODUCTION_SUPABASE_REF }, "none")].map((VITE_SUPABASE_ANON_KEY) => ({ ...appleEnv, VITE_SUPABASE_ANON_KEY })),
  ]) assert.throws(() => appleProductionConfig(env), (error) => /Apple production builds require/.test(error.message) && !error.message.includes("LEAK_CANARY"));
});

test("missing production public configuration cannot partially modify any Apple plist", () => {
  const root = scratchRoot([row("still-access-a")]);
  try {
    const originals = APPLE_PLISTS.map((path) => readFileSync(join(root, path)));
    assert.throws(() => applyApplePlists(root, join(root, "backup"), { env: {} }), /VITE_SUPABASE_URL/);
    APPLE_PLISTS.forEach((path, i) => assert.ok(readFileSync(join(root, path)).equals(originals[i])));
    assert.equal(existsSync(join(root, "backup")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("plist restore preserves concurrent edits and backup without partially restoring other targets", () => {
  const root = scratchRoot([row("still-access-a")]);
  const backup = join(root, "backup");
  try {
    const originals = APPLE_PLISTS.map((path) => readFileSync(join(root, path)));
    applyApplePlists(root, backup, { env: appleEnv });
    const last = APPLE_PLISTS.at(-1);
    const applied = readFileSync(join(root, last), "utf8");
    writeFileSync(join(root, last), applied.replace("</plist>", "<!-- concurrent owner edit -->\n</plist>"));
    const before = APPLE_PLISTS.map((path) => readFileSync(join(root, path)));
    assert.throws(() => restoreApplePlists(root, backup), /changed after the overlay/);
    APPLE_PLISTS.forEach((path, i) => assert.ok(readFileSync(join(root, path)).equals(before[i])));
    assert.ok(existsSync(join(backup, "manifest.json")));
    writeFileSync(join(root, last), applied);
    // An already restored target is accepted; the rest still restore from their overlays.
    writeFileSync(join(root, APPLE_PLISTS[0]), originals[0]);
    assert.equal(restoreApplePlists(root, backup), true);
    APPLE_PLISTS.forEach((path, i) => assert.ok(readFileSync(join(root, path)).equals(originals[i])));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("with no keys pinned the Apple plists are left untouched; refused rows touch nothing", () => {
  for (const keys of [[], [row("still-qa", { environment: "sandbox" })]]) {
    const root = paidOff(scratchRoot(keys));
    try {
      const originals = APPLE_PLISTS.map((path) => readFileSync(join(root, path)));
      if (keys.length) assert.throws(() => applyApplePlists(root, join(root, "backup")), /production/);
      else assert.equal(applyApplePlists(root, join(root, "backup")), null);
      APPLE_PLISTS.forEach((path, i) => assert.ok(readFileSync(join(root, path)).equals(originals[i])));
      assert.equal(existsSync(join(root, "backup")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the server comparison passes only when the server's public key, kid and environment digests match a pinned row", () => {
  const rows = parseStoreTrust(file([row("still-access-a"), row("still-access-b")]));
  const secrets = (r, environment = "production") => [
    { name: "ACCESS_PROOF_ENVIRONMENT", value: sha256(environment) },
    { name: "ACCESS_PROOF_KEY_ID", value: sha256(r.kid) },
    { name: "ACCESS_PROOF_PUBLIC_KEY_HEX", value: sha256(r.publicKeyHex) },
    { name: "ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64", value: sha256("never seen here") },
  ];
  assert.deepEqual(compareServerDigests(rows, secrets(rows[0])), { ok: true, signingRow: "current", checks: compareServerDigests(rows, secrets(rows[0])).checks });
  assert.equal(compareServerDigests(rows, secrets(rows[1])).signingRow, "standby");
  assert.equal(compareServerDigests(rows, secrets(row("unpinned"))).ok, false);
  assert.equal(compareServerDigests(rows, secrets(rows[0], "sandbox")).ok, false);
  assert.equal(compareServerDigests(rows, secrets({ ...rows[0], kid: "other" })).ok, false);
  assert.equal(compareServerDigests([], secrets(rows[0])).ok, false);
  assert.equal(compareServerDigests(rows, []).ok, false);
  assert.throws(() => compareServerDigests(rows, {}), /supabase secrets list/);
});

test("the CLI checks the committed file and prints only public values", () => {
  // The committed 3.x tree declares the paid tier, so `check` needs server digests. These are digests of the
  // committed public row (what a matching server reports), which exercises the CLI, not real server agreement.
  const trust = readStoreTrust(ROOT);
  const dir = mkdtempSync(join(tmpdir(), "still-trust-cli-"));
  try {
    const digests = join(dir, "digests.json");
    if (trust.paid) {
      const [current] = trust.rows;
      writeFileSync(digests, JSON.stringify([
        { name: "ACCESS_PROOF_ENVIRONMENT", value: sha256("production") },
        { name: "ACCESS_PROOF_KEY_ID", value: sha256(current.kid) },
        { name: "ACCESS_PROOF_PUBLIC_KEY_HEX", value: sha256(current.publicKeyHex) },
      ]));
      const bare = spawnSync(process.execPath, [join(ROOT, "scripts/release/access-trust.mjs"), "check"], { encoding: "utf8" });
      assert.equal(bare.status, 1);
      assert.match(bare.stderr, /declares the paid tier, so the build needs the server's secret digests/);
    }
    const check = spawnSync(process.execPath, [join(ROOT, "scripts/release/access-trust.mjs"), "check", ...(trust.paid ? ["--server-secrets-json", digests] : [])], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /^production access trust: \d key\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const env = spawnSync(process.execPath, [join(ROOT, "scripts/release/access-trust.mjs"), "env"], { encoding: "utf8" });
  assert.equal(env.status, 0, env.stderr);
  const lines = env.stdout.trim().split("\n");
  assert.deepEqual(lines.map((l) => l.slice(0, l.indexOf("="))), ["VITE_ACCESS_ENVIRONMENT", "VITE_ACCESS_PUBLIC_KEYS"]);
  assert.equal(lines[0], "VITE_ACCESS_ENVIRONMENT=production");
  assert.doesNotMatch(env.stdout, /private|pkcs8/i);
  assert.equal(spawnSync(process.execPath, [join(ROOT, "scripts/release/access-trust.mjs"), "nonsense"]).status, 2);
});
