import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("cross-platform design contract", () => {
  it("self-hosts Inter and defines system dark and reduced-motion modes", () => {
    const tokens = read("src/ui/tokens.css");

    expect(tokens).toContain("@font-face");
    expect(tokens).toContain('font-family: "InterVariable"');
    expect(tokens).toContain("font-display: swap");
    expect(tokens).toContain("@media (prefers-color-scheme: dark)");
    expect(tokens).toContain("@media (prefers-reduced-motion: reduce)");
    expect(tokens).toContain("box-sizing: border-box");
  });

  it("uses explicit compact popup layout instead of scaling the interface", () => {
    const chromium = read("../ext-chromium/entrypoints/popup/index.html");
    const safari = read("../ext-safari/entrypoints/popup/index.html");

    expect(chromium).not.toMatch(/\bzoom\s*:/);
    expect(safari).not.toMatch(/\bzoom\s*:/);
  });

  it("keeps the Apple shell zoomable and follows system appearance", () => {
    const enablement = read(
      "../../apps/apple/Still/Shared (App)/Resources/Base.lproj/Main.html",
    );
    const iosInfo = read("../../apps/apple/Still/iOS (App)/Info.plist");

    expect(enablement).not.toContain("user-scalable=no");
    expect(iosInfo).not.toContain("UIUserInterfaceStyle");
  });

  it("uses the same typeface on the linked privacy and support surfaces", () => {
    const privacy = read("../../docs/privacy.html");
    const support = read("../../docs/support.html");

    expect(privacy).toContain('font-family: "InterVariable"');
    expect(support).toContain('font-family: "InterVariable"');
  });
});
