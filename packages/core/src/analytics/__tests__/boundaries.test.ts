import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Content scripts run inside YouTube, Instagram, Facebook and TikTok pages. The promise that Still
// never records browsing history is kept structurally: nothing a content script loads may reach
// the analytics module; content scripts report nothing at all.

const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(here, "../../../..");
const coreSrc = join(packagesDir, "core/src");
const analyticsDir = join(coreSrc, "analytics");

const CONTENT_ENTRIES = [
  join(coreSrc, "content"),
  join(packagesDir, "ext-chromium/entrypoints/content"),
  join(packagesDir, "ext-safari/entrypoints/content"),
];

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : filesUnder(path);
    return /\.(ts|js|svelte)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else if (spec.startsWith("@still/core/")) base = join(coreSrc, spec.slice("@still/core/".length));
  else if (spec === "@still/core") base = join(coreSrc, "index");
  else return null;
  base = base.replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, `${base}.svelte.ts`, `${base}.svelte`, join(base, "index.ts"), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function reachable(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g)) {
      const target = resolveImport(file, match[1] ?? match[2] ?? match[3]!);
      if (target) stack.push(target);
    }
  }
  return seen;
}

describe("analytics boundary", () => {
  it("no content script can reach the analytics module", () => {
    const entries = CONTENT_ENTRIES.flatMap(filesUnder);
    expect(entries.length).toBeGreaterThan(0);
    const leaks = [...reachable(entries)].filter((f) => f.startsWith(analyticsDir));
    expect(leaks).toEqual([]);
  });
});
