import { test, expect, fixture } from "./_extension.js";
import { EXTRAS_FEATURE_CLASS, expectOnlyFreeScopedRules, serve, setAllExtras, stillResidue } from "./_extras-helpers.js";
import {
  EXTRAS_CONTROLS,
  EXTRAS_FEATURE_WORDS,
  FREE_FEATURE_CLASS,
  SERVICE_ROUTE_GLOB,
  extrasFixture,
  fixtureIds,
} from "../../packages/core/src/rules/__tests__/extras-fixtures.js";

// A4 (dormant) for all 12 Pro extras, on the SHIPPED Chromium build while the paid tier is off.
// Synthetic schema-2 settings turn every extra On, then every synthetic fixture page is loaded:
// nothing may be hidden, marked, restyled or redirected, and the free Shorts/Reels behaviour must
// match the same pages with the extras Off. The fixtures' selector families are unverified
// candidates; this spec asserts only that the dormant build does not act on them.

// Configured builds keep the legacy settings document until the modern settings rollout, so they
// never run the format-2 lane (same rule as fixtures-format2.spec.ts).
const syncConfigured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
test.skip(
  syncConfigured,
  "Format-2 lane needs committed schema-2 settings; configured builds stay on the legacy lane",
);

test.use({ settingsProfile: "modern" });

const ALL_PAGES = EXTRAS_CONTROLS.flatMap((control) =>
  control.pages.map((page) => ({ control, page, name: `${control.feature} ${page.file} ${new URL(page.url).pathname}${new URL(page.url).search}` })),
);

for (const { control, page: spec, name } of ALL_PAGES)
  test(`dormant: ${name} is left untouched with every extra On`, async ({ context, extensionId }) => {
    await setAllExtras(context, extensionId, true);
    const html = extrasFixture(spec.file);
    const page = await context.newPage();
    await serve(page, SERVICE_ROUTE_GLOB[control.service], html);
    await page.goto(spec.url);

    // The engine really ran here: the free feature's owned class is the proof of life.
    await expect(page.locator("html")).toHaveClass(FREE_FEATURE_CLASS[control.service]);
    await page.waitForTimeout(300); // let any late (wrongly) scheduled work land
    expect(page.url(), "no redirect").toBe(spec.url);

    // Targets stay attached AND visible; preserved content stays visible.
    for (const id of fixtureIds(html, "target-")) {
      await expect(page.locator(`#${id}`), id).toHaveCount(1);
      await expect(page.locator(`#${id}`), id).toBeVisible();
    }
    for (const id of fixtureIds(html, "keep-")) {
      const hiddenByDesign = await page.locator(`#${id}`).evaluate((el) => el.hasAttribute("hidden"));
      if (!hiddenByDesign) await expect(page.locator(`#${id}`), id).toBeVisible();
    }

    // Nothing marked, no extras class, no extras CSS, no placeholder.
    const residue = await stillResidue(page);
    expect(residue.attributes, "no data-still-* markers").toEqual([]);
    for (const word of EXTRAS_FEATURE_WORDS)
      expect(residue.classes.filter((c) => c.slice(c.indexOf(".still-")).includes(word)), `no ${word} class`).toEqual([]);
    expect(residue.classes.filter((c) => EXTRAS_FEATURE_CLASS.test(c)), "no extras feature class on any element").toEqual([]);
    expectOnlyFreeScopedRules(residue.rules);
    expect(residue.ownedElements, "no Still placeholder or notice").toBe(0);
    expect(residue.sheets.join("\n")).not.toMatch(/ytd-watch-next-secondary-results-renderer|ytp-ce-element|ytp-endscreen-content|ytd-comments|ytd-live-chat-frame|threads\.(com|net)/);
  });

for (const service of ["youtube", "instagram", "facebook"] as const)
  test(`dormant: ${service} owned stylesheet and classes are identical with the extras On or Off`, async ({ context, extensionId }) => {
    const spec = EXTRAS_CONTROLS.find((c) => c.service === service)!.pages[0]!;
    const html = extrasFixture(spec.file);
    const snapshot = async () => {
      const page = await context.newPage();
      await serve(page, SERVICE_ROUTE_GLOB[service], html);
      await page.goto(spec.url);
      await expect(page.locator("html")).toHaveClass(FREE_FEATURE_CLASS[service]);
      const residue = await stillResidue(page);
      await page.close();
      return residue;
    };
    await setAllExtras(context, extensionId, false);
    const off = await snapshot();
    await setAllExtras(context, extensionId, true);
    const on = await snapshot();
    expect(on.classes).toEqual(off.classes);
    expect(on.sheets).toEqual(off.sheets);
    expect(on.rules).toEqual(off.rules);
    expect(on.attributes).toEqual(off.attributes);
  });

// Free behaviour on the repo's existing fixtures must be identical with all 12 extras On.
const freeCases = [
  ["youtube", "youtube.html", "https://www.youtube.com/feed/subscriptions", ["#shelf", "#rich-shorts-section", "#subs-shorts-shelf", "#shorts-chip"]],
  ["instagram", "instagram-home.html", "https://www.instagram.com/", ["#reel-post", "#nav-reels"]],
  ["facebook", "facebook.html", "https://www.facebook.com/", ["#reel-article", "#reels-shortcut"]],
] as const;

for (const [service, file, url, targets] of freeCases)
  test(`dormant: free ${service} Shorts/Reels hiding is unchanged with every extra On`, async ({ context, extensionId }) => {
    await setAllExtras(context, extensionId, true);
    const page = await context.newPage();
    await serve(page, SERVICE_ROUTE_GLOB[service], fixture(file));
    await page.goto(url);
    await expect(page.locator("html")).toHaveClass(FREE_FEATURE_CLASS[service]);
    for (const id of targets) {
      await expect(page.locator(id), id).toHaveCount(1);
      await expect(page.locator(id), id).toBeHidden();
    }
    const kept = await page.locator('[id^="keep-"]').evaluateAll((nodes) => nodes.map((n) => `#${n.id}`));
    expect(kept.length).toBeGreaterThan(0);
    for (const id of kept) await expect(page.locator(id), id).toBeVisible();
    const residue = await stillResidue(page);
    for (const word of EXTRAS_FEATURE_WORDS)
      expect(residue.classes.filter((c) => c.slice(c.indexOf(".still-")).includes(word)), `no ${word} class`).toEqual([]);
    expectOnlyFreeScopedRules(residue.rules);
  });

test("dormant: free Shorts and Reels routes still redirect with every extra On", async ({ context, extensionId }) => {
  await setAllExtras(context, extensionId, true);
  const yt = await context.newPage();
  await yt.route("**://*.youtube.com/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: route.request().url().includes("/watch") ? "<!doctype html><title>watch</title>watch" : fixture("youtube.html") }),
  );
  await yt.goto("https://www.youtube.com/shorts/abc123");
  await expect(yt).toHaveURL(/\/watch\?v=abc123$/);

  const ig = await context.newPage();
  await serve(ig, "**://*.instagram.com/**", fixture("instagram-mobile.html"));
  await ig.goto("https://www.instagram.com/reels/");
  await expect(ig).toHaveURL("https://www.instagram.com/");
});

test("dormant: a scripted video end does not click, cancel, navigate or reload on the autoplay fixture", async ({ context, extensionId }) => {
  await setAllExtras(context, extensionId, true);
  const page = await context.newPage();
  await serve(page, SERVICE_ROUTE_GLOB.youtube, extrasFixture("yt-autoplay.html"));
  const url = "https://www.youtube.com/watch?v=inv300001";
  await page.goto(url);
  await expect(page.locator("html")).toHaveClass(FREE_FEATURE_CLASS.youtube);
  type Probe = { toggleClicks: number; cancelClicks: number; ended: number; loads: number; token: string };
  const read = () => page.evaluate(() => (window as unknown as { __autoplayProbe: Probe }).__autoplayProbe);
  const before = await read();
  expect(before.loads, "first load of this tab").toBe(1);
  await page.evaluate(() => (window as unknown as { fireEnded(): void }).fireEnded());
  await page.waitForTimeout(500);
  const after = await read();
  expect(after.ended, "the scripted ended event reached its target exactly once").toBe(1);
  expect(after.toggleClicks).toBe(0);
  expect(after.cancelClicks).toBe(0);
  // Same document (token) and still the first load: no reload, and no bounce back to the same URL.
  expect(after.token).toBe(before.token);
  expect(after.loads).toBe(1);
  expect(await page.evaluate(() => sessionStorage.getItem("autoplayProbeLoads"))).toBe("1");
  expect(page.url()).toBe(url);
  await expect(page.locator("#keep-autonav-overlay")).toBeVisible();
});
