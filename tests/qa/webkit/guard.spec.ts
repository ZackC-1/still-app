import { expect, test } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APPLE_WEBVIEW, SAFARI_EXTENSION } from "./harness.js";
import { BOUNDARY_SHIM_MARKER } from "./shim/boundary-shim.js";

// Guard: the recorded-state boundary shim is test code. No product source may import it, no
// package may expose it, and no built bundle may contain it. Each check also proves it can see a
// planted reference, so a silent scan (wrong root, wrong extensions) cannot pass vacuously.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const PRODUCT_ROOTS = ["packages", "apps", "supabase", "scripts", ".github"].map((p) => join(REPO, p));
const SKIP_DIRS = new Set(["node_modules", "dist", ".output", ".wxt", "build", "DerivedData", ".git"]);
const SOURCE = /\.(ts|tsx|js|mjs|cjs|svelte|swift|json|html|sh|plist|pbxproj|yml|yaml)$/;

/** Anything that would let product code reach the shim or its native model. */
const SHIM_REFERENCE = /tests\/qa\/webkit|qa\/webkit\/|boundary-shim|native-model|__stillQaBoundary|__STILL_QA_BOUNDARY_SHIM__/;

export function shimReferences(files: readonly { path: string; text: string }[]): string[] {
  return files.filter((f) => SHIM_REFERENCE.test(f.text)).map((f) => f.path);
}

function productSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else if (SOURCE.test(name) && info.size < 2_000_000) out.push({ path: relative(REPO, path), text: readFileSync(path, "utf8") });
    }
  };
  for (const root of PRODUCT_ROOTS) if (existsSync(root)) walk(root);
  return out;
}

test.describe("QA shim stays out of product code", () => {
  test("the scan finds a planted import (negative control)", () => {
    const planted = [
      { path: "packages/core/src/x.ts", text: 'import { installBoundaryShim } from "../../../tests/qa/webkit/shim/boundary-shim.js";' },
      { path: "packages/ext-safari/lib/y.ts", text: "const ok = 1;" },
    ];
    expect(shimReferences(planted)).toEqual(["packages/core/src/x.ts"]);
  });

  test("no product source references the shim or its native model", () => {
    const sources = productSources();
    // The walk really covered the product packages (not an empty or wrong root).
    expect(sources.some((f) => f.path.startsWith("packages/ext-safari/"))).toBe(true);
    expect(sources.some((f) => f.path.startsWith("packages/app-webview/src/"))).toBe(true);
    expect(sources.some((f) => f.path.startsWith("packages/core/src/storage/"))).toBe(true);
    // ...and the build and release config that could pull a file into a product: CI workflows,
    // Xcode project and plists, and shell scripts.
    for (const kind of [/^\.github\/.*\.ya?ml$/, /\.pbxproj$/, /\.plist$/, /\.sh$/])
      expect(sources.some((f) => kind.test(f.path)), String(kind)).toBe(true);
    expect(shimReferences(sources)).toEqual([]);
  });

  test("no package exposes or compiles anything under tests/", () => {
    for (const pkg of readdirSync(join(REPO, "packages"))) {
      for (const file of ["package.json", "tsconfig.json"]) {
        const path = join(REPO, "packages", pkg, file);
        if (!existsSync(path)) continue;
        expect(readFileSync(path, "utf8"), `${pkg}/${file}`).not.toMatch(/(\.\.\/)+tests\b/);
      }
    }
  });

  for (const [name, root] of [
    ["Safari extension", SAFARI_EXTENSION],
    ["Apple web view", APPLE_WEBVIEW],
  ] as const) {
    test(`the built ${name} contains no shim code`, () => {
      test.skip(!existsSync(root), `${root} is not built`);
      const files: { path: string; text: string }[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (statSync(path).isDirectory()) walk(path);
          else if (/\.(js|html|css|json)$/.test(name)) files.push({ path: relative(REPO, path), text: readFileSync(path, "utf8") });
        }
      };
      walk(root);
      expect(files.length).toBeGreaterThan(0);
      expect(shimReferences(files)).toEqual([]);
      expect(files.filter((f) => f.text.includes(BOUNDARY_SHIM_MARKER)).map((f) => f.path)).toEqual([]);
    });
  }
});
