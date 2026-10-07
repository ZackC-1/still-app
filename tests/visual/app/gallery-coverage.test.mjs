import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const require = createRequire(join(repo, "packages/core/package.json"));
const referenceSnapshot = JSON.parse(
  readFileSync(join(here, "latest-gallery-references.json"), "utf8"),
);

function assertReferenceCoverage(cases, frames) {
  assert.equal(cases.length, frames.length);
  assert.equal(new Set(cases.map((c) => c.reference)).size, frames.length);
  assert.deepEqual(
    cases.map((c) => c.reference).sort(),
    frames.map((f) => f.reference).sort(),
  );
  for (const c of cases) {
    const f = frames.find((f) => f.reference === c.reference);
    assert.equal(c.theme, f.theme, c.id);
    assert.equal(c.width, f.width, c.id);
    assert.equal(c.frame.width, f.width, c.id);
  }
}
const { createViteServer: createServer } = await import(
  pathToFileURL(require.resolve("vitest/node")).href
);
const { svelte, vitePreprocess } = await import(
  pathToFileURL(require.resolve("@sveltejs/vite-plugin-svelte")).href
);

test("latest gallery registry covers all 33 specimens with production components and accessibility cases", async () => {
  const server = await createServer({
    configFile: false,
    root: here,
    logLevel: "error",
    plugins: [svelte({ configFile: false, preprocess: vitePreprocess() })],
    resolve: {
      alias: [
        {
          find: /^@still\/shared-types$/,
          replacement: join(repo, "packages/shared-types/src/index.ts"),
        },
      ],
    },
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    const { GALLERY } = await server.ssrLoadModule("/cases/gallery.ts");
    const { D28 } = await server.ssrLoadModule("/cases/d28.ts");
    // Normal CI always checks exact rendered reference metadata; a developer-provided
    // reference directory is an additional check, never the only authority.
    assert.equal(referenceSnapshot.designVersion, "3.0.1");
    assert.equal(referenceSnapshot.frames.length, 33);
    const source = join(repo, "docs/design/Still v3.1 redesign/source");
    for (const input of referenceSnapshot.sourceInputs) {
      assert.equal(
        createHash("sha256")
          .update(readFileSync(join(source, input.path)))
          .digest("hex"),
        input.sha256,
        `Latest reference source changed: ${input.path}; regenerate reviewed metadata`,
      );
    }
    assertReferenceCoverage(GALLERY.cases, referenceSnapshot.frames);
    // Mutate the actual loaded registry to prove that the original silent-CI gap
    // and independent dimension/theme regressions are rejected without env.
    for (const change of [
      { reference: "not-a-latest-gallery-reference.png" },
      { width: 1 },
      { theme: "dark" },
      { frame: { kind: "gallery", width: 1 } },
    ]) {
      const corrupted = GALLERY.cases.map((c, index) =>
        index === 0 ? { ...c, ...change } : c,
      );
      assert.throws(() =>
        assertReferenceCoverage(corrupted, referenceSnapshot.frames),
      );
    }
    assert.equal(GALLERY.cases.length, 33);
    assert.equal(new Set(GALLERY.cases.map((c) => c.reference)).size, 33);
    assert.equal(GALLERY.defaultUnmappedReason, undefined);
    assert.equal(
      GALLERY.cases.filter((c) => c.frame.kind === "gallery").length,
      33,
    );
    assert.ok(
      GALLERY.cases.every((c) => typeof c.render().component === "function"),
    );
    assert.ok(GALLERY.cases.find((c) => c.reference === "31-focus.png").focus);
    assert.equal(
      GALLERY.cases.find(
        (c) => c.reference === "32-150-text-text-scale-320-wide.png",
      ).textScale,
      1.5,
    );
    assert.ok(
      GALLERY.cases.find((c) => c.reference === "33-long-text.png").callerCopy,
    );
    assert.ok(D28.cases.find((c) => c.reference === "08-owner-view-draft.png"));
    assert.match(D28.unmapped["07-apple-host-native.png"], /native|StoreKit/);
    assert.equal(D28.unmapped["08-owner-view-draft.png"], undefined);
    if (process.env.STILL_VISUAL_REFERENCE_DIR) {
      const inventory = JSON.parse(
        readFileSync(
          join(process.env.STILL_VISUAL_REFERENCE_DIR, "render-inventory.json"),
          "utf8",
        ),
      );
      const frames = inventory.inventory.find(
        (p) => p.name === "System gallery",
      ).frames;
      assert.equal(inventory.design_version, referenceSnapshot.designVersion);
      // The reference's outer frame scale is separate from Gallery32's inner
      // --text-scale:1.5, which is asserted against the actual registry above.
      for (const f of frames) {
        const pinned = referenceSnapshot.frames.find(
          (p) => p.reference === f.output,
        );
        assert.equal(Number(f.render.text_scale), pinned?.textScale, f.output);
      }
      assertReferenceCoverage(
        GALLERY.cases,
        frames.map((f) => ({
          reference: f.output,
          theme: f.render.theme,
          width: f.bounding_box.width,
          textScale: Number(f.render.text_scale),
        })),
      );
    }
  } finally {
    await server.close();
  }
});
