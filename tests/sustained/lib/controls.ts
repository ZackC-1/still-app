// Negative controls. Each one is a disposable copy of the built extension with one deliberate fault
// appended to its content script, so the harness can be shown to catch it. The shipping artifact
// and the engine source are never touched; the copy is deleted after the run and the artifact's
// hash is checked before and after.
import { createHash } from "node:crypto";
import { appendFile, cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ControlName = "observer-leak" | "listener-leak" | "long-task";

/** Plain browser JavaScript appended to content-scripts/content.js in the copy. */
const FAULTS: Record<ControlName, string> = {
  // A MutationObserver created on every settings change and never disconnected.
  "observer-leak": `
;(() => {
  const leaked = [];
  chrome.storage.onChanged.addListener(() => {
    const observer = new MutationObserver(() => { leaked.length; });
    observer.observe(document, { childList: true, subtree: true });
    leaked.push(observer);
  });
})();`,
  // A document listener added on every settings change and never removed.
  "listener-leak": `
;(() => {
  chrome.storage.onChanged.addListener(() => {
    document.addEventListener("scroll", () => {}, { passive: true });
  });
})();`,
  // A 60 ms busy loop whenever the page adds elements: one long task per feed batch.
  "long-task": `
;(() => {
  new MutationObserver((records) => {
    if (!records.some((r) => r.addedNodes.length)) return;
    const end = performance.now() + 60;
    while (performance.now() < end) {}
  }).observe(document, { childList: true, subtree: true });
})();`,
};

export async function artifactHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      const child = join(dir, name);
      if ((await stat(child)).isDirectory()) await visit(child);
      else hash.update(child.slice(path.length)).update(await readFile(child));
    }
  }
  await visit(path);
  return hash.digest("hex");
}

/** A disposable copy of `built` carrying one fault. Call `remove()` when done. */
export async function faultyCopy(built: string, control: ControlName): Promise<{ path: string; remove(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), `still-sustained-${control}-`));
  const path = join(dir, "extension");
  await cp(built, path, { recursive: true });
  const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8")) as {
    content_scripts: { js: string[] }[];
  };
  await appendFile(join(path, manifest.content_scripts[0]!.js[0]!), FAULTS[control]);
  return { path, remove: () => rm(dir, { recursive: true, force: true }) };
}

export function controlFromEnv(): ControlName | null {
  const value = process.env.STILL_SUSTAINED_CONTROL;
  if (!value) return null;
  if (value in FAULTS) return value as ControlName;
  throw new Error(`Unknown STILL_SUSTAINED_CONTROL "${value}" (use ${Object.keys(FAULTS).join(", ")})`);
}
