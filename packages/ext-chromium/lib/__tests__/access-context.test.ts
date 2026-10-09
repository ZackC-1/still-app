import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RuntimePlatform } from "../runtime-platform.js";

// Firefox for Android's only gate against the desktop-layout-only extras is the background's
// access context (content entries pass only their host). Explicit paid-on seam, scoped here.
vi.mock("@still/shared-types", async (original) => ({
  ...await original<typeof import("@still/shared-types")>(), PAID_TIER_ENABLED: true,
}));
const { hostAccessContext } = await import("../access-context.js");

const DESKTOP_LAYOUT_ONLY = ["youtube.endscreen", "youtube.livechat", "facebook.sponsored"] as const;
const reader = (platform: RuntimePlatform) => vi.fn(async () => platform);

describe("background host access context", () => {
  it.each(["android", "unknown"] as const)("Firefox on %s never resolves a desktop-layout-only extra", async (platform) => {
    const read = reader(platform);
    const context = await hostAccessContext("firefox", read);
    expect(read).toHaveBeenCalledOnce();
    expect(context.paidMode).toBe(true);
    for (const id of DESKTOP_LAYOUT_ONLY) expect(context.supported.has(id), id).toBe(false);
    for (const id of ["youtube.autoplay", "youtube.comments", "youtube.related"] as const) expect(context.supported.has(id), id).toBe(true);
  });

  it("desktop Firefox and Chromium keep every extra", async () => {
    for (const host of ["firefox", "chromium"] as const) {
      const context = await hostAccessContext(host, reader("desktop"));
      for (const id of DESKTOP_LAYOUT_ONLY) expect(context.supported.has(id), `${host}:${id}`).toBe(true);
    }
  });

  it("the background resolves its access context through this helper with the platform reader", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../../entrypoints/background.ts"), "utf8");
    expect(source).toMatch(/await hostAccessContext\(import\.meta\.env\.FIREFOX \? "firefox" : "chromium", accessPlatform\)/);
    expect(source).toMatch(/const accessPlatform = accessPlatformReader\(platformAnswer\)/);
    expect(source).not.toMatch(/packagedAccessContext\(/);
  });
});
