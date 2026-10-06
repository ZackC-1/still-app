import { describe, expect, it } from "vitest";
// The Firefox for Android emulator spike's reading of Android's "isn't responding" dialog. It lives
// with the spike (tests/firefox-android) and is pure, so it is tested here, off the emulator.
import { notRespondingDialog } from "../../../../tests/firefox-android/_system-dialog.js";

const node = (text: string, packageName = "android", x = 0, y = 0) => ({ text, packageName, center: { x, y } });

describe("Android's isn't-responding dialog in the Firefox for Android spike", () => {
  it("names another app and offers its Wait button, so the spike may answer it", () => {
    const wait = node("Wait", "android", 540, 1367);
    const dialog = notRespondingDialog([node("Pixel Launcher isn't responding"), node("Close app"), wait]);
    expect(dialog).toEqual({ app: "Pixel Launcher", firefox: false, wait });
  });

  it("recognises Firefox itself, so the spike fails instead of hiding the hang", () => {
    for (const app of ["Firefox", "Firefox Beta", "Firefox Nightly", "Fenix", "Mozilla Firefox"])
      expect(notRespondingDialog([node(`${app} isn't responding`), node("Wait")])).toMatchObject({ app, firefox: true });
  });

  it("sees no dialog in ordinary screens, including Firefox's own text that merely mentions it", () => {
    expect(notRespondingDialog([node("Allow", "org.mozilla.firefox"), node("Deny", "org.mozilla.firefox")])).toBeNull();
    expect(notRespondingDialog([node("Pixel Launcher isn't responding", "org.mozilla.firefox")])).toBeNull();
  });
});
