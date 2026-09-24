import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Contract test for the 2.1 showcase images (docs/release/screenshots/source/frames/frames.json):
// every committed store image has its store's exact pixel size, and no headline makes a claim the
// accuracy rules in docs/release/store-listing-copy.md forbid. Rendering stays a manual step
// (render-frames.mjs pulls live captures), so this reads the committed files rather than re-rendering.

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMES = resolve(HERE, "../../docs/release/screenshots/source/frames");
const STORE_READY = resolve(HERE, "../../docs/release/screenshots/store-ready");
const { canvases, frames } = JSON.parse(readFileSync(resolve(FRAMES, "frames.json"), "utf8"));

// The sizes each store asks for (Apple: 6.9" iPhone, 13" iPad and the largest Mac size; Chrome and
// Firefox: 1280x800; Instagram: 4:5 feed and 9:16 story; Open Graph: 1200x630).
const STORE_SIZES: Record<string, [number, number]> = {
  chrome: [1280, 800], firefox: [1280, 800], iphone: [1320, 2868], ipad: [2064, 2752],
  mac: [2880, 1800], ig: [1080, 1350], story: [1080, 1920], og: [1200, 630],
};
// The last rule catches a claim that Still blocks inside apps (it works on websites only), e.g.
// "blocks Reels in the Instagram app", without flagging "the Still app … Just the blocking".
const BANNED = [/everywhere/i, /forever/i, /no tracking/i, /\bblock\w*\b[^.]*\b(?:in|inside)\s+(?:the\s+)?(?:\w+\s+)?apps?\b/i];

function dimensions(file: string): [number, number] {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)]; // PNG IHDR
  for (let i = 2; i < b.length; ) { // JPEG: walk segments to the start-of-frame marker
    const marker = b[i + 1], len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  throw new Error(`no image size in ${file}`);
}

test("each canvas renders at its store's exact size", () => {
  for (const [name, c] of Object.entries<{ w: number; h: number; scale: number }>(canvases)) {
    expect([c.w * c.scale, c.h * c.scale], name).toEqual(STORE_SIZES[name]);
  }
});

for (const f of frames.filter((x: { draft?: string }) => !x.draft)) {
  test(`${f.id}: committed image has the store size and an accurate headline`, () => {
    const c = canvases[f.canvas];
    const file = resolve(STORE_READY, c.out, `${f.id}-${c.w * c.scale}x${c.h * c.scale}.${c.format}`);
    expect(existsSync(file), file).toBe(true);
    expect(dimensions(file)).toEqual(STORE_SIZES[f.canvas]);
    const words = `${f.headline} ${f.subline ?? ""}`;
    for (const rule of BANNED) expect(words, `${f.id} must not say ${rule}`).not.toMatch(rule);
  });
}
