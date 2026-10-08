import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  argumentsFor,
  assertFontEvidence,
  assertInputsStable,
  assertPngDimensions,
  closeResources,
  PINNED_INPUTS,
  prepareInputs,
  reserveOutput,
  snapshot,
  startServer,
  staticBytes,
  validateVersions,
  verifyIntegrity,
} from "./capture.mjs";

const cli = fileURLToPath(new URL("./capture.mjs", import.meta.url));
test("server startup rejects emitted bind errors before browser work", async () => {
  const server = new EventEmitter();
  const failure = new Error("Controlled bind EACCES");
  server.listen = (port, host) => {
    assert.equal(port, 0);
    assert.equal(host, "127.0.0.1");
    queueMicrotask(() => server.emit("error", failure));
  };
  await assert.rejects(startServer(server), (error) => error === failure);
  assert.equal(server.listenerCount("error"), 0);
});
test("successful startup removes its temporary bind error listener", async () => {
  const server = new EventEmitter();
  server.listen = (_port, _host, done) => queueMicrotask(done);
  await startServer(server);
  assert.equal(server.listenerCount("error"), 0);
});
test("server cleanup is awaited even when browser cleanup fails", async () => {
  const calls = [];
  const failure = new Error("Browser cleanup failed");
  const browser = {
    async close() {
      calls.push("browser");
      throw failure;
    },
  };
  const server = {
    listening: true,
    close(done) {
      queueMicrotask(() => {
        calls.push("server");
        done();
      });
    },
  };
  await assert.rejects(
    closeResources(browser, server),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ["browser", "server"]);
});
test("cleanup preserves the first error and rejects server close callback failures", async () => {
  const first = new Error("Browser cleanup failed");
  const second = new Error("Server cleanup failed");
  const server = {
    listening: true,
    close(done) {
      queueMicrotask(() => done(second));
    },
  };
  await assert.rejects(
    closeResources(undefined, server),
    (error) => error === second,
  );
  await assert.rejects(
    closeResources(
      {
        async close() {
          throw first;
        },
      },
      server,
    ),
    (error) => error === first,
  );
  await closeResources(undefined, {
    listening: false,
    close() {
      assert.fail("Unbound server must not be closed");
    },
  });
});

async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "still-reference-test-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, "source"),
    cache = join(root, "cache");
  await mkdir(pkg);
  await mkdir(cache);
  await mkdir(join(pkg, "tokens"));
  await mkdir(join(pkg, "handoff"));
  await writeFile(
    join(pkg, "tokens/tokens.json"),
    JSON.stringify({ version: "3.0.1" }),
  );
  await writeFile(
    join(pkg, "tokens/spacing.css"),
    ':root { --ds-version: "3.0.1"; }',
  );
  const pages = Array.from({ length: 10 }, (_, i) => ({
    name: `Screen ${i}`,
    page: `page-${i}.html`,
    frames: [],
  }));
  for (const page of pages)
    await writeFile(join(pkg, page.page), "<h1>Still</h1>");
  await writeFile(
    join(pkg, "handoff/screens.json"),
    JSON.stringify({ version: "3.0.1", pages }),
  );
  return { root, pkg, cache, output: join(root, "fresh"), pages };
}

test("all three CLI inputs are explicit and duplicate/unknown flags fail", () => {
  assert.throws(() => argumentsFor([]), /Explicit/);
  assert.throws(
    () => argumentsFor(["--package", "/tmp/p", "--output", "/tmp/o"]),
    /Explicit/,
  );
  assert.throws(
    () => argumentsFor(["--package", "/tmp/p", "--package", "/tmp/q"]),
    /once/,
  );
  assert.throws(() => argumentsFor(["--overwrite"]), /once/);
  assert.deepEqual(
    argumentsFor([
      "--output",
      "/tmp/o",
      "--cache",
      "/tmp/c",
      "--package",
      "/tmp/p",
      "--icons",
    ]),
    { output: "/tmp/o", cache: "/tmp/c", package: "/tmp/p", icons: true },
  );
});
test("version metadata requires exactly one matching CSS declaration, ignoring comments", () => {
  validateVersions(
    { version: "3.0.1" },
    '/* --ds-version:"old"; */ :root{--ds-version:"3.0.1";}',
    { version: "3.0.1" },
  );
  for (const css of [
    "",
    '--ds-version:"3.0.0";',
    '--ds-version:"3.0.1";--ds-version:"3.0.1";',
    "--ds-version:3.0.1;",
  ])
    assert.throws(
      () => validateVersions({ version: "3.0.1" }, css, { version: "3.0.1" }),
      /exactly one/,
    );
  assert.throws(
    () =>
      validateVersions({ version: "3.0.0" }, '--ds-version:"3.0.1";', {
        version: "3.0.1",
      }),
    /3.0.1/,
  );
  assert.throws(
    () =>
      validateVersions({ version: "3.0.1" }, '--ds-version:"3.0.1";', {
        version: "3.0.0",
      }),
    /3.0.1/,
  );
});
test("actual cached bytes are compared with SHA384, not trusted cache metadata", () => {
  assert.equal(PINNED_INPUTS.length, 3);
  assert.equal(new Set(PINNED_INPUTS.map(([url]) => url)).size, 3);
  const bytes = Buffer.from("actual input"),
    integrity = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  verifyIntegrity(bytes, integrity);
  assert.throws(
    () => verifyIntegrity(Buffer.from("modified"), integrity),
    /integrity/,
  );
  assert.throws(() => verifyIntegrity(bytes, PINNED_INPUTS[0][1]), /integrity/);
});
test("a stale package fails the real CLI before creating output or launching a browser", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.pkg, "tokens/tokens.json"), '{"version":"3.0.0"}');
  const result = spawnSync(
    process.execPath,
    [cli, "--package", f.pkg, "--cache", f.cache, "--output", f.output],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /latest design 3.0.1/);
  await assert.rejects(
    readFile(join(f.output, "capture-receipt.json")),
    /ENOENT/,
  );
});
test("altered cached bytes fail actual preflight before output reservation", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++)
    await writeFile(join(f.cache, `${i}.js`), "forged cached content");
  await assert.rejects(
    prepareInputs({ package: f.pkg, cache: f.cache }),
    /integrity mismatch/,
  );
  const result = spawnSync(
    process.execPath,
    [cli, "--package", f.pkg, "--cache", f.cache, "--output", f.output],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /integrity mismatch/);
  await assert.rejects(
    readFile(join(f.output, "capture-receipt.json")),
    /ENOENT/,
  );
});
test("existing outputs and source/cache descendants are rejected without changing accepted bytes", async (t) => {
  const f = await fixture(t);
  await mkdir(f.output);
  await writeFile(join(f.output, "accepted.png"), "accepted pixels");
  await assert.rejects(reserveOutput(f.pkg, f.cache, f.output), /EEXIST/);
  await assert.rejects(
    reserveOutput(f.pkg, f.cache, join(f.pkg, "new")),
    /outside/,
  );
  await assert.rejects(
    reserveOutput(f.pkg, f.cache, join(f.cache, "new")),
    /outside/,
  );
  assert.equal(
    await readFile(join(f.output, "accepted.png"), "utf8"),
    "accepted pixels",
  );
});
test("output parent symlinks cannot redirect a new capture into source", async (t) => {
  const f = await fixture(t);
  await symlink(f.pkg, join(f.root, "alias"));
  await assert.rejects(
    reserveOutput(f.pkg, f.cache, join(f.root, "alias/new")),
    /outside/,
  );
  const output = await reserveOutput(
    f.pkg,
    f.cache,
    join(f.root, "fresh-output"),
  );
  assert.equal(output, join(f.root, "fresh-output"));
});
test("static serving rejects traversal, unknown files, input mutations and symlink escapes", async (t) => {
  const f = await fixture(t),
    before = await snapshot(f.pkg);
  assert.equal(
    (await staticBytes(f.pkg, "/page-0.html", before)).toString(),
    "<h1>Still</h1>",
  );
  for (const path of ["/%2e%2e%2fsecret", "/..\\secret", "/%00secret"])
    await assert.rejects(staticBytes(f.pkg, path, before), /Invalid/);
  await writeFile(join(f.pkg, "new.html"), "new");
  await assert.rejects(staticBytes(f.pkg, "/new.html", before), /snapshot/);
  await writeFile(join(f.pkg, "page-0.html"), "changed");
  await assert.rejects(staticBytes(f.pkg, "/page-0.html", before), /snapshot/);
  await writeFile(join(f.root, "outside.html"), "private");
  await symlink(join(f.root, "outside.html"), join(f.pkg, "escape.html"));
  await assert.rejects(staticBytes(f.pkg, "/escape.html", before), /escapes/);
  await assert.rejects(snapshot(f.pkg), /symlink escapes/);
});
test("stable receipt checking detects additions, source/cache changes and replacement changes", async (t) => {
  const f = await fixture(t),
    wordmarkPath = join(f.root, "wordmark.ts");
  await writeFile(wordmarkPath, "shared");
  const path = join(f.cache, "0.js");
  await writeFile(path, "cache");
  const input = {
    pkg: f.pkg,
    cache: f.cache,
    source: await snapshot(f.pkg),
    wordmarkPath,
    replacementBytes: Buffer.from("shared"),
    libraries: [
      { path, sha256: createHash("sha256").update("cache").digest("hex") },
    ],
  };
  await assertInputsStable(input);
  await writeFile(join(f.pkg, "new"), "addition");
  await assert.rejects(assertInputsStable(input), /Source inputs changed/);
  await rm(join(f.pkg, "new"));
  await writeFile(path, "modified");
  await assert.rejects(assertInputsStable(input), /Cached inputs changed/);
  await writeFile(path, "cache");
  await writeFile(wordmarkPath, "new shared");
  await assert.rejects(assertInputsStable(input), /Shared wordmark changed/);
});
test("a nonexistent Inter check or fallback face cannot establish actual font use", () => {
  const loaded = [{ family: "InterVariable", status: "loaded" }],
    rendered = [{ familyName: "Inter", isCustomFont: true, glyphCount: 15 }];
  assertFontEvidence(loaded, rendered);
  for (const faces of [
    [],
    [{ family: "Inter", status: "loaded" }],
    [{ family: "InterVariable", status: "unloaded" }],
  ])
    assert.throws(() => assertFontEvidence(faces, rendered), /fallback/);
  for (const fonts of [
    [],
    [{ familyName: "Arial", isCustomFont: false, glyphCount: 15 }],
    [{ familyName: "Inter", isCustomFont: true, glyphCount: 0 }],
  ])
    assert.throws(() => assertFontEvidence(loaded, fonts), /fallback/);
});
test("decoded PNG dimensions enclose fractional origins and extents at DSF2", () => {
  const box = { x: 10.25, y: 20.75, width: 100.5, height: 50.5 };
  assertPngDimensions({ width: 202, height: 104 }, box);
  assert.throws(
    () => assertPngDimensions({ width: 201, height: 101 }, box),
    /must be/,
  );
  assert.throws(
    () => assertPngDimensions({ width: 202, height: 104 }, { ...box, x: NaN }),
    /bounding box/,
  );
});
