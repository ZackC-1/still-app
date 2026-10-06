import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { notRespondingDialog } from "./_system-dialog.js";
import { join } from "node:path";

// The small slice of adb this spike needs: shell commands, screenshots, and "tap the native button
// whose label or id matches". Everything inside web pages goes through WebDriver BiDi instead; adb
// only covers what BiDi cannot see, which is Firefox's own Android UI (onboarding, the permission
// prompt) and the emulator's display size.

export const ARTIFACTS = process.env.STILL_ANDROID_ARTIFACTS ?? "test-results/firefox-android";
mkdirSync(ARTIFACTS, { recursive: true });

const SERIAL = process.env.ANDROID_SERIAL ?? "emulator-5554";

export function adb(...args: string[]): string {
  return execFileSync("adb", ["-s", SERIAL, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

export function shell(command: string): string {
  return adb("shell", command);
}

/** A screenshot of the whole emulator display, Firefox's own UI included. */
export function screencap(name: string): string {
  const path = join(ARTIFACTS, `${name}.png`);
  const png = execFileSync("adb", ["-s", SERIAL, "exec-out", "screencap", "-p"], {
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(path, png);
  return path;
}

export interface NativeNode {
  readonly text: string;
  readonly resourceId: string;
  readonly className: string;
  readonly packageName: string;
  readonly clickable: boolean;
  readonly center: { readonly x: number; readonly y: number };
}

/** Firefox itself is "not responding": the run must fail, never dismiss it. */
export class FirefoxNotResponding extends Error {}

/**
 * The native view tree (uiautomator). Saved as an artifact so a failed match can be read later.
 * Android's own "<app> isn't responding" dialog (_system-dialog.ts) is handled first. When it
 * names Firefox, Firefox has hung and this throws FirefoxNotResponding. For any other app (a busy
 * emulator once showed it for the Pixel Launcher) it is answered "Wait", logged to
 * system-dialogs.txt, and the tree is read again, at most three times. Each dialog keeps its dump.
 */
export function nativeNodes(name: string): NativeNode[] {
  for (let attempt = 1; ; attempt++) {
    const nodes = readNativeNodes(name);
    const dialog = notRespondingDialog(nodes);
    if (!dialog) return nodes;
    const dump = join(ARTIFACTS, `${name}-system-dialog-${attempt}.xml`);
    writeFileSync(dump, readFileSync(join(ARTIFACTS, `${name}.xml`)));
    if (dialog.firefox)
      throw new FirefoxNotResponding(
        `Android shows "${dialog.app} isn't responding" over the screen, so Firefox itself hung; see ${dump}`,
      );
    if (!dialog.wait || attempt > 3) return nodes;
    console.warn(`[spike] Android dialog "${dialog.app} isn't responding" (attempt ${attempt}); answering Wait`);
    appendFileSync(
      join(ARTIFACTS, "system-dialogs.txt"),
      `${name}\tattempt ${attempt}\t${dialog.app} isn't responding\tanswered Wait\t${dump}\n`,
    );
    shell(`input tap ${dialog.wait.center.x} ${dialog.wait.center.y}`);
    shell("sleep 2");
  }
}

function readNativeNodes(name: string): NativeNode[] {
  shell("uiautomator dump /sdcard/still-ui.xml >/dev/null 2>&1 || true");
  const xml = shell("cat /sdcard/still-ui.xml 2>/dev/null || true");
  writeFileSync(join(ARTIFACTS, `${name}.xml`), xml);
  const nodes: NativeNode[] = [];
  for (const match of xml.matchAll(/<node\b([^>]*)>/g)) {
    const attrs = match[1]!;
    const attr = (key: string) =>
      new RegExp(`\\b${key}="([^"]*)"`).exec(attrs)?.[1] ?? "";
    const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr("bounds"));
    if (!bounds) continue;
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number) as [number, number, number, number];
    nodes.push({
      text: attr("text"),
      resourceId: attr("resource-id"),
      className: attr("class"),
      packageName: attr("package"),
      clickable: attr("clickable") === "true",
      center: { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) },
    });
  }
  return nodes;
}

/** Tap the first native node that matches, and report which one (or null when nothing matched). */
export function tapNative(
  name: string,
  match: (node: NativeNode) => boolean,
): NativeNode | null {
  const node = nativeNodes(name).find(match) ?? null;
  if (node) shell(`input tap ${node.center.x} ${node.center.y}`);
  return node;
}

/** Set the emulator's display to `dp` density-independent pixels wide at 2x (xhdpi). */
export function setDisplayWidthDp(dp: number): void {
  const density = 320;
  const width = Math.round((dp * density) / 160);
  const height = Math.round((780 * density) / 160);
  // The density is fixed before Firefox starts (run-spike.sh); only the width changes here.
  shell(`wm size ${width}x${height}`);
}

export function resetDisplay(): void {
  shell("wm size reset");
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
