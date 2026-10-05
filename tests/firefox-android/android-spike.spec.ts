import { test, expect } from "@playwright/test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bidi, EXTENSION_UUID, type Json } from "../firefox/_bidi.js";
import { StillFirefox, Tab, fixture } from "../firefox/_session.js";
import {
  ARTIFACTS,
  nativeNodes,
  resetDisplay,
  screencap,
  setDisplayWidthDp,
  shell,
  sleep,
  tapNative,
} from "./_adb.js";

// U14-W3 spike: real Firefox for Android in a CI emulator, driven over WebDriver BiDi through an adb
// port forward. It answers, in priority order:
//   1. Does Still install, and does the first-run page's "Allow" (permissions.request for the four
//      sites) show Firefox's prompt, and can it be granted? This decides whether Android is feasible.
//   2. Does the popup page render within the screen at 320, 360 and 412 dp? (screenshots + geometry)
//   3. Does one synthetic fixture page work? (served from tests/fixtures; no real site is visited)
//
// It is a spike, not a gate. Every step records what happened in report.json and summary.md, so a
// step that cannot be automated says exactly where it stopped instead of failing silently. The run
// fails only when a step that did run produced the wrong answer, or a prerequisite could not run.
//
// Not covered: the real toolbar-menu popup overlay (opened through Firefox's own menu, which BiDi
// cannot reach; popup.html is loaded as a page instead), real sites, sign-in, a real device.

const ENDPOINT = process.env.STILL_ANDROID_BIDI ?? "ws://127.0.0.1:9222";
const PACKAGE = process.env.STILL_ANDROID_XPI ?? "";
const ORIGINS = [
  "*://*.youtube.com/*",
  "*://*.instagram.com/*",
  "*://*.facebook.com/*",
  "*://*.tiktok.com/*",
];
const EXTENSION = `moz-extension://${EXTENSION_UUID}`;

type Outcome = "pass" | "fail" | "stopped" | "info";
interface Step {
  readonly step: string;
  readonly outcome: Outcome;
  readonly detail: unknown;
}
const steps: Step[] = [];
function record(step: string, outcome: Outcome, detail: unknown = null): void {
  steps.push({ step, outcome, detail });
  console.log(`[spike] ${outcome.toUpperCase()} ${step}: ${JSON.stringify(detail)}`);
}

function writeReport(): void {
  const report = {
    firefox: process.env.FENIX_VERSION ?? "unknown",
    apiLevel: process.env.ANDROID_API_LEVEL ?? "unknown",
    steps,
  };
  writeFileSync(join(ARTIFACTS, "report.json"), JSON.stringify(report, null, 2));
  const lines = [
    `### Firefox for Android ${report.firefox} (Android API ${report.apiLevel})`,
    "",
    "| Step | Outcome | Detail |",
    "|---|---|---|",
    ...steps.map(
      (s) =>
        `| ${s.step} | ${s.outcome} | ${JSON.stringify(s.detail).replace(/\|/g, "\\|").slice(0, 400)} |`,
    ),
    "",
  ];
  writeFileSync(join(ARTIFACTS, "summary.md"), lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
}

async function connect(timeoutMs = 120_000): Promise<Bidi> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      return await Bidi.connect(ENDPOINT);
    } catch (error) {
      last = error;
      await sleep(2_000);
    }
  }
  throw new Error(`no WebDriver BiDi endpoint at ${ENDPOINT}: ${String(last)}`);
}

async function topContexts(bidi: Bidi): Promise<Json[]> {
  const tree = await bidi.send("browsingContext.getTree", { maxDepth: 0 });
  return (tree.contexts as Json[]) ?? [];
}

/** A tab to drive: a new one where BiDi can create it, otherwise an existing top-level one. */
async function anyTab(bidi: Bidi): Promise<Tab> {
  try {
    const created = await bidi.send("browsingContext.create", { type: "tab" });
    record("open a tab over BiDi", "info", "browsingContext.create supported");
    return new Tab(bidi, created.context as string);
  } catch (error) {
    const [first] = await topContexts(bidi);
    if (!first) throw new Error(`no tab to drive (create failed: ${String(error)})`, { cause: error });
    record("open a tab over BiDi", "info", `create unsupported (${String(error)}); reusing ${first.url}`);
    return new Tab(bidi, first.context as string);
  }
}

async function pageScreenshot(bidi: Bidi, tab: Tab, name: string): Promise<void> {
  try {
    const shot = await bidi.send("browsingContext.captureScreenshot", { context: tab.context });
    writeFileSync(join(ARTIFACTS, `${name}.page.png`), Buffer.from(shot.data as string, "base64"));
  } catch (error) {
    record(`page screenshot ${name}`, "info", `captureScreenshot failed: ${String(error)}`);
  }
  try {
    screencap(name);
  } catch (error) {
    record(`device screenshot ${name}`, "info", String(error));
  }
}

/** A real, trusted tap on the element (BiDi input actions), so the page sees a user gesture. */
async function tapElement(bidi: Bidi, tab: Tab, finder: string): Promise<boolean> {
  const rect = await tab.evaluate<{ x: number; y: number } | null>(`(() => {
    const el = (${finder})();
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!rect) return false;
  await bidi.send("input.performActions", {
    context: tab.context,
    actions: [
      {
        type: "pointer",
        id: "still-finger",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x: rect.x, y: rect.y, origin: "viewport" },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
  return true;
}

/** Firefox's own first-launch screens sit on top of every tab; tap through the obvious ones. */
async function dismissOnboarding(): Promise<string[]> {
  const tapped: string[] = [];
  const labels = /^(not now|skip|maybe later|close|continue|get started|agree and continue|no thanks)$/i;
  for (let round = 0; round < 6; round++) {
    let node: ReturnType<typeof tapNative> = null;
    try {
      node = tapNative(`onboarding-${round}`, (n) =>
        n.packageName.startsWith("org.mozilla.") && n.clickable && labels.test(n.text.trim()),
      );
    } catch (error) {
      tapped.push(`could not read the native screen: ${String(error)}`);
    }
    if (!node) break;
    tapped.push(node.text);
    await sleep(1_500);
  }
  return tapped;
}

test.describe.configure({ mode: "serial" });

test.afterAll(() => {
  try {
    resetDisplay();
  } catch {
    /* the emulator may already be gone */
  }
  writeReport();
});

test("Firefox for Android spike", async () => {
  test.setTimeout(20 * 60_000);

  // 0. Prerequisites: the build under test and a reachable Firefox.
  if (!PACKAGE || !existsSync(PACKAGE)) {
    record("extension package", "stopped", `STILL_ANDROID_XPI missing: ${PACKAGE}`);
    throw new Error("No extension package to install");
  }
  const tapped = await dismissOnboarding();
  record("dismiss Firefox onboarding (native UI)", "info", tapped.length ? tapped : "nothing to dismiss");

  let bidi: Bidi;
  try {
    bidi = await connect();
    const status = await bidi.send("session.status");
    record("connect WebDriver BiDi over adb", "pass", status);
  } catch (error) {
    record(
      "connect WebDriver BiDi over adb",
      "stopped",
      `${String(error)}. Firefox did not open its remote-debugging port from the GeckoView config file; ` +
        "see logcat.txt and remote-sockets.txt. Next manual step: enable Settings > Remote debugging via USB " +
        "and use web-ext run --target=firefox-android.",
    );
    screencap("stopped-no-bidi");
    throw error;
  }

  // 1. Install, then the feasibility question: site access from the first-run page.
  let firefox: StillFirefox;
  try {
    firefox = await StillFirefox.attach(
      { bidi, version: process.env.FENIX_VERSION ?? "unknown", stop: async () => bidi.close() },
      { type: "base64", value: readFileSync(PACKAGE).toString("base64") },
    );
    record("install Still as a temporary add-on (webExtension.install)", "pass");
  } catch (error) {
    record("install Still as a temporary add-on (webExtension.install)", "fail", String(error));
    screencap("install-failed");
    throw error;
  }
  firefox.serve((url) => {
    if (url.pathname.startsWith("/watch")) return "<!doctype html><title>watch</title>watch";
    if (url.hostname.endsWith("youtube.com")) return fixture("youtube.html");
    return null;
  });

  // The install opens the first-run page by itself (background onInstalled → tabs.create).
  let firstRun: Tab | null = null;
  for (let i = 0; i < 30 && !firstRun; i++) {
    const found = (await topContexts(bidi)).find((c) => String(c.url).endsWith("/first-run.html"));
    if (found) firstRun = new Tab(bidi, found.context as string);
    else await sleep(1_000);
  }
  record("first-run page opens by itself on install", firstRun ? "pass" : "fail");
  expect.soft(firstRun, "the first-run page opens on a fresh install").not.toBeNull();
  if (!firstRun) {
    firstRun = await anyTab(bidi);
    await firstRun.goto(`${EXTENSION}/first-run.html`);
  }
  try {
    await bidi.send("browsingContext.activate", { context: firstRun.context });
  } catch (error) {
    record("bring first-run tab to front", "info", String(error));
  }
  await firstRun.waitFor("the first-run page to render", () => firstRun!.count("ol.steps > li.step"), (n) => n > 0, 20_000);

  const platform = await firstRun.evaluate<{ os: string }>("browser.runtime.getPlatformInfo()");
  record("runtime.getPlatformInfo().os", platform.os === "android" ? "pass" : "fail", platform);
  expect.soft(platform.os).toBe("android");

  const pinStep = await firstRun.evaluate<boolean>(
    `[...document.querySelectorAll("ol.steps > li.step")].some((li) => li.textContent.includes("Pin Still to your toolbar"))`,
  );
  record("first-run hides the toolbar pin step on Android", pinStep ? "fail" : "pass", { pinStep });
  expect.soft(pinStep).toBe(false);
  await pageScreenshot(bidi, firstRun, "first-run-before-allow");

  const contains = `browser.permissions.contains({ origins: ${JSON.stringify(ORIGINS)} })`;
  const grantedAtInstall = await firstRun.evaluate<boolean>(contains);
  record("site access granted at install (no prompt needed)", "info", grantedAtInstall);
  let granted = grantedAtInstall;
  if (!grantedAtInstall) {
    let clicked = false;
    try {
      clicked = await tapElement(
        bidi,
        firstRun,
        `() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Allow" && !b.disabled)`,
      );
    } catch (error) {
      record("tap Allow with a trusted BiDi pointer action", "stopped", String(error));
    }
    record("tap Allow with a trusted BiDi pointer action", clicked ? "pass" : "fail");
    await sleep(3_000);
    screencap("permission-prompt");
    const nodes = nativeNodes("permission-prompt");
    const promptTexts = nodes
      .filter((n) => n.packageName.startsWith("org.mozilla.") && n.text.trim())
      .map((n) => n.text.trim());
    const allowNode = nodes.find(
      (n) =>
        n.packageName.startsWith("org.mozilla.") &&
        n.clickable &&
        (/allow/i.test(n.resourceId) || /^allow$/i.test(n.text.trim())),
    );
    record("Firefox shows a native permission prompt", allowNode ? "pass" : "fail", promptTexts.slice(0, 20));
    expect.soft(allowNode, "Firefox for Android shows a prompt with an Allow button").toBeTruthy();
    if (allowNode) {
      shell(`input tap ${allowNode.center.x} ${allowNode.center.y}`);
      await sleep(3_000);
      screencap("permission-prompt-after-tap");
    }
    granted = await firstRun.evaluate<boolean>(contains);
    record("permissions.request grant reaches the extension", granted ? "pass" : "fail", { granted });
  }
  expect.soft(granted, "the four sites can be granted on Firefox for Android").toBe(true);
  await pageScreenshot(bidi, firstRun, "first-run-after-allow");
  const firstRunAllowed = await firstRun.evaluate<boolean>(
    `document.body.textContent.includes("Allowed on YouTube, Instagram, Facebook and TikTok.")`,
  );
  record("first-run page shows the granted state", firstRunAllowed ? "pass" : "fail", { firstRunAllowed });

  // 2. Popup rendering at three phone widths. popup.html loads as a page here: the real toolbar
  //    overlay opens from Firefox's own menu, which BiDi cannot drive.
  const popup = await anyTab(bidi);
  for (const dp of [320, 360, 412]) {
    try {
      setDisplayWidthDp(dp);
      await sleep(2_500);
      await popup.goto(`${EXTENSION}/popup.html`);
      await popup.waitFor("the popup to render its services", () => popup.count(".still-ui .service-row"), (n) => n >= 4, 20_000);
      const geometry = await popup.evaluate<Json>(`(() => {
        const root = document.documentElement;
        const frame = document.querySelector(".popup")?.getBoundingClientRect();
        const controls = [...document.querySelectorAll("button, [role=switch], a")]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0);
        return {
          innerWidth: window.innerWidth,
          clientWidth: root.clientWidth,
          scrollWidth: root.scrollWidth,
          popupLeft: frame?.left ?? null,
          popupRight: frame?.right ?? null,
          rightmostControl: Math.max(...controls.map((r) => r.right)),
          leftmostControl: Math.min(...controls.map((r) => r.left)),
          desktopPresentation: Boolean(document.querySelector('.still-ui.app[style*="max-inline-size"]')),
        };
      })()`);
      const fits =
        geometry.scrollWidth <= geometry.clientWidth &&
        geometry.rightmostControl <= geometry.innerWidth + 0.5 &&
        geometry.leftmostControl >= -0.5;
      // The size change must have reached the page, or "fits at 320 dp" would prove nothing.
      const sized = Math.abs(geometry.innerWidth - dp) <= 2;
      record(`display at ${dp} dp reached the page`, sized ? "pass" : "fail", { innerWidth: geometry.innerWidth });
      expect.soft(sized, `page width is ${dp} dp`).toBe(true);
      record(`popup at ${dp} dp fits the screen`, fits ? "pass" : "fail", geometry);
      record(`popup at ${dp} dp uses the phone presentation`, geometry.desktopPresentation ? "fail" : "pass");
      expect.soft(fits, `popup fits at ${dp} dp`).toBe(true);
      expect.soft(geometry.desktopPresentation, `phone presentation at ${dp} dp`).toBe(false);
      await pageScreenshot(bidi, popup, `popup-${dp}dp`);
    } catch (error) {
      record(`popup at ${dp} dp`, "fail", String(error));
      expect.soft(String(error)).toBe("");
    }
  }
  resetDisplay();

  // 3. One synthetic fixture check. Only meaningful once the four sites are granted.
  if (!granted) {
    record("fixture: m.youtube.com Shorts address ends on the watch page", "stopped", "site access not granted");
    return;
  }
  try {
    const page = await anyTab(bidi);
    await page.goto("https://m.youtube.com/shorts/abc123");
    const url = await page.waitFor("the Shorts redirect", () => page.url(), (u) => u.includes("/watch"), 20_000);
    record("fixture: m.youtube.com Shorts address ends on the watch page", url.includes("/watch?v=abc123") ? "pass" : "fail", url);
    expect.soft(url).toMatch(/\/watch\?v=abc123/);
    await pageScreenshot(bidi, page, "fixture-youtube-redirect");
  } catch (error) {
    record("fixture: m.youtube.com Shorts address ends on the watch page", "fail", String(error));
    expect.soft(String(error)).toBe("");
  }
});
