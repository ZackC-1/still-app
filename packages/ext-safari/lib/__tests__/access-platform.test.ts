import { describe, expect, it } from "vitest";
import { accessCapabilities } from "@still/core/entitlement";
import { boundedSafariOs, safariAccessPlatform, safariPlatformAnswer } from "../access-platform.js";

describe("safariAccessPlatform", () => {
  it("maps only Safari's own platform answer: mac is desktop, ios is iPhone/iPad, anything else unknown", () => {
    expect(safariAccessPlatform("mac")).toBe("desktop");
    expect(safariAccessPlatform("ios")).toBe("ios");
    for (const os of [undefined, "", "android", "win", "linux", "ipados", "Mac"]) expect(safariAccessPlatform(os), String(os)).toBe("unknown");
  });

  it("an iPhone, iPad or unknown answer never claims a desktop-layout control, paid on", () => {
    for (const os of ["ios", undefined]) {
      const supported = accessCapabilities({ paidMode: true, host: "safari", platform: safariAccessPlatform(os) });
      for (const id of ["youtube.endscreen", "youtube.livechat", "facebook.sponsored"] as const) expect(supported.has(id), `${os}:${id}`).toBe(false);
      for (const id of ["youtube.autoplay", "youtube.comments", "youtube.related"] as const) expect(supported.has(id), `${os}:${id}`).toBe(true);
    }
    const mac = accessCapabilities({ paidMode: true, host: "safari", platform: safariAccessPlatform("mac") });
    for (const id of ["youtube.endscreen", "youtube.livechat", "youtube.autoplay", "facebook.sponsored"] as const) expect(mac.has(id), id).toBe(true);
  });
});

describe("bounded Safari platform answer", () => {
  it("passes Safari's answer through and maps it", async () => {
    expect(await boundedSafariOs(async () => ({ os: "mac" }))).toBe("mac");
    expect(await safariPlatformAnswer(async () => ({ os: "ios" }))).toBe("ios");
    expect(await safariPlatformAnswer(async () => ({ os: "mac" }))).toBe("desktop");
  });

  it("a failed, malformed or late answer is unknown and never rejects", async () => {
    expect(await safariPlatformAnswer(async () => { throw new Error("no"); })).toBe("unknown");
    expect(await safariPlatformAnswer(async () => undefined)).toBe("unknown");
    expect(await safariPlatformAnswer(async () => ({ os: 7 as unknown as string }))).toBe("unknown");
    expect(await safariPlatformAnswer(() => new Promise(() => {}), 20)).toBe("unknown");
  });
});
