import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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

/** The native view tree (uiautomator). Saved as an artifact so a failed match can be read later. */
export function nativeNodes(name: string): NativeNode[] {
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
