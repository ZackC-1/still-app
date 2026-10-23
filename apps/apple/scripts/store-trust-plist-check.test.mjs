import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkStoreTrustFields, exemption } from "./store-trust-plist-check.mjs";

// RC2 P2: a Release build of a Still app or Safari extension target refuses a built Info.plist that
// does not carry the pinned production access trust (StillAccessEnvironment = production and the
// rows of scripts/release/production-access-keys.json in StillAccessTrustKeys). archive.sh writes
// those fields; an archive made from the Xcode GUI or a raw `xcodebuild archive` without
// `access-trust.mjs apple-apply` would otherwise ship a Still that can never verify Still Pro.

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const CHECK = join(SCRIPTS, "store-trust-plist-check.mjs");
const PBXPROJ = join(SCRIPTS, "../Still/Still.xcodeproj/project.pbxproj");
const QA_BUILDER = join(SCRIPTS, "paid-sandbox-qa.mjs");
const ARCHIVE = join(SCRIPTS, "archive.sh");
const PINNED = JSON.parse(readFileSync(join(SCRIPTS, "../../../scripts/release/production-access-keys.json"), "utf8")).keys;
const PRODUCTION = { StillAccessEnvironment: "production", StillAccessTrustKeys: PINNED };
const roots = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("the store trust verdict (pure, every platform)", () => {
  test("the repository pins at least one production key (3.0 declares the paid tier)", () => {
    assert.ok(PINNED.length >= 1);
  });

  test("the pinned production rows pass", () => {
    assert.deepEqual(checkStoreTrustFields(PRODUCTION, PINNED), []);
  });

  test("the same rows with their fields in another order pass (plist dict order is not meaningful)", () => {
    const reordered = PINNED.map(({ kid, publicKeyHex, environment, purpose }) => ({ purpose, environment, publicKeyHex, kid }));
    assert.deepEqual(checkStoreTrustFields({ ...PRODUCTION, StillAccessTrustKeys: reordered }, PINNED), []);
  });

  test("an empty key list is refused", () => {
    const problems = checkStoreTrustFields({ ...PRODUCTION, StillAccessTrustKeys: [] }, PINNED);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /StillAccessTrustKeys is empty/);
  });

  test("missing fields (the default source plists) are refused", () => {
    const problems = checkStoreTrustFields({}, PINNED);
    assert.equal(problems.length, 2);
    assert.match(problems.join("\n"), /StillAccessEnvironment is missing/);
    assert.match(problems.join("\n"), /StillAccessTrustKeys is missing/);
  });

  test("a sandbox environment (the QA overlay) is refused", () => {
    const problems = checkStoreTrustFields({ ...PRODUCTION, StillAccessEnvironment: "sandbox" }, PINNED);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /StillAccessEnvironment is not "production"/);
  });

  test("a key that is not the pinned one is refused", () => {
    const other = [{ ...PINNED[0], publicKeyHex: "0".repeat(64) }];
    assert.match(checkStoreTrustFields({ ...PRODUCTION, StillAccessTrustKeys: other }, PINNED).join("\n"), /does not match/);
  });

  test("a non-array key value is refused", () => {
    assert.match(checkStoreTrustFields({ ...PRODUCTION, StillAccessTrustKeys: "x" }, PINNED).join("\n"), /StillAccessTrustKeys is not a list/);
  });

  test("with nothing pinned (a free release), the plist must carry no trust at all, as archive.sh leaves it", () => {
    assert.deepEqual(checkStoreTrustFields({}, []), []);
    assert.match(checkStoreTrustFields(PRODUCTION, []).join("\n"), /none is pinned/);
  });

  test("only simulator builds and the QA builder's explicit setting are exempt", () => {
    assert.equal(exemption({}), null);
    assert.equal(exemption({ PLATFORM_NAME: "macosx" }), null);
    assert.equal(exemption({ PLATFORM_NAME: "iphoneos" }), null);
    assert.equal(exemption({ PLATFORM_NAME: "iphoneos", STILL_NON_STORE_BUILD: "NO" }), null);
    assert.equal(exemption({ PLATFORM_NAME: "macosx", STILL_NON_STORE_BUILD: "1" }), null, "only the exact value YES");
    assert.match(exemption({ PLATFORM_NAME: "iphonesimulator" }), /simulator/);
    assert.match(exemption({ PLATFORM_NAME: "macosx", STILL_NON_STORE_BUILD: "YES" }), /QA/);
  });
});

// The command runs plutil, so it is exercised on macOS only (CI's Linux runner checks the verdict above).
describe("the command against fixture Info.plists", { skip: process.platform !== "darwin" && "plutil is macOS-only" }, () => {
  const xml = (value) =>
    Array.isArray(value) ? `<array>${value.map(xml).join("")}</array>`
      : typeof value === "object" ? `<dict>${Object.entries(value).map(([k, v]) => `<key>${k}</key>${xml(v)}`).join("")}</dict>`
        : `<string>${value}</string>`;
  const plist = (fields, { binary = false } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "still-trust-plist-"));
    roots.push(dir);
    const path = join(dir, "Info.plist");
    writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict><key>CFBundleIdentifier</key><string>com.chartash.still</string>${Object.entries(fields).map(([k, v]) => `<key>${k}</key>${xml(v)}`).join("")}</dict>\n</plist>\n`);
    if (binary) assert.equal(spawnSync("/usr/bin/plutil", ["-convert", "binary1", path]).status, 0);
    return path;
  };
  const run = (path, env = {}) => {
    const r = spawnSync(process.execPath, [CHECK, path], { env: { PATH: process.env.PATH, PLATFORM_NAME: "macosx", ...env }, encoding: "utf8" });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };

  test("one pinned production key passes, in XML and in the binary form Xcode writes", () => {
    for (const binary of [false, true]) {
      const r = run(plist(PRODUCTION, { binary }));
      assert.equal(r.status, 0, r.output);
      assert.match(r.output, /production access trust/);
    }
  });

  test("an empty key list fails with an Xcode error line", () => {
    const r = run(plist({ ...PRODUCTION, StillAccessTrustKeys: [] }));
    assert.equal(r.status, 1);
    assert.match(r.output, /^error: .*StillAccessTrustKeys is empty/m);
    assert.match(r.output, /archive\.sh/, "and says how to archive correctly");
  });

  test("missing fields fail", () => {
    const r = run(plist({}));
    assert.equal(r.status, 1);
    assert.match(r.output, /StillAccessEnvironment is missing/);
    assert.match(r.output, /StillAccessTrustKeys is missing/);
  });

  test("a sandbox environment fails", () => {
    const r = run(plist({ ...PRODUCTION, StillAccessEnvironment: "sandbox" }));
    assert.equal(r.status, 1);
    assert.match(r.output, /not "production"/);
  });

  test("run through a symlinked path (Xcode's SRCROOT under /tmp), it still checks rather than silently passing", () => {
    const dir = mkdtempSync(join(tmpdir(), "still-trust-link-"));
    roots.push(dir);
    const link = join(dir, "scripts");
    symlinkSync(SCRIPTS, link);
    const r = spawnSync(process.execPath, [join(link, "store-trust-plist-check.mjs"), plist({})], { env: { PATH: process.env.PATH, PLATFORM_NAME: "macosx" }, encoding: "utf8" });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /StillAccessTrustKeys is missing/);
  });

  test("an unreadable plist fails closed", () => {
    const r = run(join(tmpdir(), "still-no-such-dir", "Info.plist"));
    assert.equal(r.status, 1);
    assert.match(r.output, /^error: /m);
  });

  test("a simulator build and the QA builder's build are skipped with a note", () => {
    for (const env of [{ PLATFORM_NAME: "iphonesimulator" }, { STILL_NON_STORE_BUILD: "YES" }]) {
      const r = run(plist({}), env);
      assert.equal(r.status, 0, r.output);
      assert.match(r.output, /^note: store access trust check skipped/m);
    }
  });
});

describe("wiring", () => {
  const phases = () => {
    const project = readFileSync(PBXPROJ, "utf8");
    return [...project.matchAll(/\/\* (Copy Still Web UI|Copy Safari Web Extension Resources) \*\/ = \{\n([\s\S]*?)\n\t\t\};/g)];
  };

  test("all four Still targets (both apps, both extensions) check their built Info.plist on Release", () => {
    const found = phases();
    assert.equal(found.length, 4, "two Copy Still Web UI phases and two extension-resources phases");
    for (const [, name, body] of found) {
      const script = body.match(/shellScript = "(.*)";/)[1];
      const check = script.indexOf("store-trust-plist-check.mjs");
      assert.ok(check > 0, `${name} runs the check`);
      assert.ok(script.includes('\\"${TARGET_BUILD_DIR}/${INFOPLIST_PATH}\\"'), `${name} checks the built product's plist`);
      const gate = script.lastIndexOf('if [ \\"${CONFIGURATION:-}\\" = \\"Release\\" ]', check);
      assert.ok(gate >= 0 && !script.slice(gate, check).includes("\\nfi\\n"), `${name} gates the check on Release`);
      assert.ok(script.startsWith("set -euo pipefail"), `${name} fails the build on a refusal`);
      // Declaring the built plist as an input orders the phase after Xcode's ProcessInfoPlistFile.
      assert.match(body, /inputPaths = \(\n\t+"\$\(TARGET_BUILD_DIR\)\/\$\(INFOPLIST_PATH\)",\n\t+\);/, `${name} declares the built plist as an input`);
    }
  });

  test("the QA builder marks its Release builds as non-store, and archive.sh forces the setting off", () => {
    const qa = readFileSync(QA_BUILDER, "utf8");
    const build = qa.slice(qa.indexOf("export async function buildAppleTarget"), qa.indexOf('runChecked("xcodebuild", args'));
    assert.ok(build.includes('"-configuration", "Release"'), "the QA builder builds Release");
    assert.ok(build.includes('args.push("STILL_NON_STORE_BUILD=YES")'), "for every target, before xcodebuild runs");
    const archive = readFileSync(ARCHIVE, "utf8");
    const call = archive.slice(archive.indexOf("xcodebuild archive"), archive.indexOf("xcodebuild -exportArchive"));
    assert.ok(call.includes("STILL_NON_STORE_BUILD=NO"), "an exported variable cannot exempt a store archive");
  });
});
