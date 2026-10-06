// U19 sustained-session performance harness. Loads a disposable copy of the BUILT Chromium
// extension (the unconfigured build, whose fresh install commits schema-2 settings and runs the
// format-2 engine on YouTube, Instagram and Facebook) and keeps five ordinary fixture pages open for
// a long session: scrolling, feed growth, same-document navigation, settings turned off and on
// mid-session. The build folder is hashed before and after and must never change.
// No real site is contacted and nobody signs in.
//
// Run through tests/sustained/run.mjs (see its header for flags). Results go to a JSON report;
// the test fails when any gated check fails (timing checks can be made advisory with
// STILL_SUSTAINED_TIMING=advisory).
import { test, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactHash, controlFromEnv, disposableCopy } from "./lib/controls.js";
import { installMainWorldHarness, type DomWrites, type MainWorldHarness } from "./lib/main-world.js";
import { fixtureFor, SESSION_PAGES, type SessionPage } from "./lib/pages.js";
import { PageProbe, type Checkpoint } from "./lib/probe.js";
import {
  CP013,
  evaluate,
  OPEN_QUESTIONS,
  RULINGS,
  TIMING_CHECKS,
  type ScenarioResult,
  type SessionReport,
  type VisitResult,
} from "./lib/report.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUILT = resolve(process.env.STILL_CHROMIUM_EXTENSION ?? resolve(ROOT, "packages/ext-chromium/dist/chrome-mv3"));
const FIXTURES = resolve(ROOT, "tests/fixtures");
const MODE = process.env.STILL_SUSTAINED_MODE === "smoke" ? "smoke" : "full";
const MINUTES = Number(process.env.STILL_SUSTAINED_MINUTES ?? (MODE === "smoke" ? 1 : 5));
const TIMING_REQUESTED_ADVISORY = process.env.STILL_SUSTAINED_TIMING === "advisory";
// Timing on a loaded machine means nothing: above this 1-minute load average (start or end of the
// run) the timing checks are reported but cannot fail the run, and the report says why.
const MAX_LOAD = Number(process.env.STILL_SUSTAINED_MAX_LOAD ?? 20);
const CONTROL = controlFromEnv();
const REPORT = process.env.STILL_SUSTAINED_REPORT ??
  resolve(ROOT, `test-results/sustained/${MODE}${CONTROL ? `-${CONTROL}` : ""}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const MIN_ROUNDS = 2;
const log = (message: string) => console.log(`[sustained ${new Date().toISOString().slice(11, 19)}] ${message}`);

const settle = (page: Page, ms: number) => page.waitForTimeout(ms);
const frames = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const harness = <T>(page: Page, call: (h: MainWorldHarness) => T) =>
  page.evaluate(`(${call.toString()})(window.__stillHarness)`) as Promise<Awaited<T>>;

async function worker(context: BrowserContext): Promise<Worker> {
  const [sw] = context.serviceWorkers();
  return sw ?? ((await context.waitForEvent("serviceworker")) as Worker);
}

async function schemaVersion(sw: Worker): Promise<number | null> {
  return sw.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }).chrome;
    const record = (await api.storage.local.get("still:settings"))["still:settings"] as { settings?: { schemaVersion?: number } } | undefined;
    return record?.settings ? (record.settings.schemaVersion ?? 1) : null;
  });
}

const syncConfigured = process.env.STILL_TEST_SYNC_CONFIGURED === "true";
test.skip(syncConfigured, "The sustained harness measures the format-2 lane; configured builds stay on the legacy lane");

test("sustained five-page session", async () => {
  test.setTimeout((MINUTES * 60 + 600) * 1000);
  const shippingHash = await artifactHash(BUILT);
  // Never load the build folder in place: Chromium writes into an unpacked extension it loads.
  const copy = await disposableCopy(BUILT, CONTROL);
  const extensionPath = copy.path;
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const startedAt = new Date();
  const loadAtStart = loadavg()[0]!;
  try {
    const sw = await worker(context);
    const extensionOrigin = `chrome-extension://${new URL(sw.url()).host}`;
    await expect.poll(() => schemaVersion(sw), { timeout: 15_000, message: "fresh install commits schema-2 settings" }).toBe(2);
    await context.route(/^https?:\/\//, (route) => {
      const name = fixtureFor(new URL(route.request().url()));
      return name
        ? route.fulfill({ contentType: "text/html; charset=utf-8", body: readFileSync(resolve(FIXTURES, name), "utf8") })
        : route.abort();
    });
    await context.addInitScript(installMainWorldHarness);

    // The real options page: every mid-session change is a committed click on a shipped switch.
    const options = await context.newPage();
    await options.goto(`${extensionOrigin}/options.html`);
    const toggle = async (name: string, on: boolean) => {
      const control = options.getByRole("switch", { name, exact: true });
      if ((await control.getAttribute("aria-checked")) !== String(on)) await control.click();
      await expect(control).toHaveAttribute("aria-checked", String(on));
    };

    const pages = new Map<string, { def: SessionPage; page: Page; probe: PageProbe }>();
    let tiktokReallowed = 0;
    const allowTikTok = async (page: Page) => {
      await page.waitForURL(/tiktok-blocked\.html/, { waitUntil: "commit" });
      await page.getByRole("button", { name: "Open TikTok this time" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Open TikTok this time" }).click();
      await page.getByRole("button", { name: "Reload page" }).click();
      await page.waitForURL(/tiktok\.com/, { waitUntil: "load" });
    };
    for (const def of SESSION_PAGES) {
      log(`opening ${def.key}`);
      const page = await context.newPage();
      // A blocked TikTok address leaves for the extension's own page: wait only for the commit.
      await page.goto(def.url, { waitUntil: def.tiktok ? "commit" : "load" });
      if (def.tiktok) await allowTikTok(page);
      await expect(page.locator(def.keep)).toBeVisible();
      const probe = new PageProbe(page, extensionOrigin, CP013.cpuSlowdown);
      await probe.init();
      await expect.poll(() => probe.hasContentScript(), { message: `${def.key}: content script runs` }).toBe(true);
      pages.set(def.key, { def, page, probe });
    }
    const ensureTikTok = async (entry: { def: SessionPage; page: Page; probe: PageProbe }) => {
      if (!entry.def.tiktok || !/tiktok-blocked\.html/.test(entry.page.url())) return;
      tiktokReallowed++;
      await allowTikTok(entry.page);
      await entry.probe.refreshFrame();
    };

    const takeWrites = (page: Page) => harness(page, (h) => h.takeWrites()) as Promise<DomWrites>;
    const scenarios: ScenarioResult[] = [];
    const runScenario = async (phase: "start" | "end") => {
      for (const { def, page, probe } of pages.values()) {
        log(`scenario ${phase} ${def.key}`);
        await page.bringToFront();
        await harness(page, (h) => h.trim());
        await harness(page, (h) => h.scroll(-1e6));
        await frames(page);
        await takeWrites(page);
        const start = await harness(page, (h) => h.nodeCount());
        await probe.begin();
        let reached = start;
        for (let step = 1; step <= CP013.scrollSteps; step++) {
          const target = Math.round(start + ((CP013.nodes - start) * step) / CP013.scrollSteps);
          reached = await page.evaluate((t) => (window as unknown as { __stillHarness: MainWorldHarness }).__stillHarness.growTo(t), target);
          await harness(page, (h) => h.scroll(600));
          await frames(page);
        }
        await settle(page, 300);
        const measured = await probe.end();
        scenarios.push({ page: def.key, phase, engine: def.engine, nodesReached: reached, ...measured, domWrites: await takeWrites(page) });
        await harness(page, (h) => h.trim());
      }
    };

    const checkpoints: Record<string, Checkpoint[]> = {};
    const checkpoint = async () => {
      for (const { def, page, probe } of pages.values()) {
        await page.bringToFront();
        (checkpoints[def.key] ??= []).push(await probe.checkpoint());
      }
    };

    // Warm-up round (unmeasured), the start scenario, then the first leak checkpoint.
    for (const { page, def } of pages.values()) {
      await page.bringToFront();
      await harness(page, (h) => h.grow(400));
      await page.evaluate((p) => (window as unknown as { __stillHarness: MainWorldHarness }).__stillHarness.navigate(p), def.routes[0]!);
      await settle(page, 200);
      await harness(page, (h) => h.back());
      await harness(page, (h) => h.trim());
      await settle(page, 200);
    }
    log("start scenario");
    await runScenario("start");
    await checkpoint();

    const visits: VisitResult[] = [];
    const deadline = startedAt.getTime() + MINUTES * 60_000;
    let round = 0;
    while (round < MIN_ROUNDS || Date.now() < deadline) {
      round++;
      log(`round ${round}`);
      let index = 0;
      for (const entry of pages.values()) {
        const { def, page, probe } = entry;
        const toggleKind = (["none", "global", "service"] as const)[(round + index++) % 3]!;
        await page.bringToFront();
        await ensureTikTok(entry);
        await takeWrites(page);
        await probe.begin();
        for (let step = 0; step < 6; step++) {
          await harness(page, (h) => h.grow(150));
          await harness(page, (h) => h.scroll(500));
          await frames(page);
        }
        const route = def.routes[round % def.routes.length]!;
        await page.evaluate((p) => (window as unknown as { __stillHarness: MainWorldHarness }).__stillHarness.navigate(p), route);
        await harness(page, (h) => h.grow(200));
        await settle(page, 250);
        await harness(page, (h) => h.back());
        await settle(page, 250);
        let offSteadyWrites: DomWrites | null = null;
        let offSteadyCallbacks: number | null = null;
        let visitWrites = await takeWrites(page);
        if (toggleKind !== "none") {
          const name = toggleKind === "global" ? "Still" : def.serviceSwitch;
          await toggle(name, false);
          await settle(page, 400);
          visitWrites = add(visitWrites, await takeWrites(page));
          const before = await probe.end(); // close the window so Off steady state is measured alone
          await probe.begin();
          for (let step = 0; step < 4; step++) {
            await harness(page, (h) => h.grow(150));
            await harness(page, (h) => h.scroll(400));
            await frames(page);
          }
          await settle(page, 300);
          const off = await probe.end();
          offSteadyWrites = await takeWrites(page);
          offSteadyCallbacks = off.callbacks.count;
          await probe.begin();
          await toggle(name, true);
          await settle(page, 400);
          if (def.tiktok) await ensureTikTok(entry);
          await harness(page, (h) => h.trim());
          await settle(page, 200);
          const after = await probe.end();
          visits.push({
            page: def.key, round, toggle: toggleKind, url: page.url(), growBatches: 11,
            profile: mergeProfiles(before.profile, off.profile, after.profile),
            callbacks: mergeCallbacks(before.callbacks, off.callbacks, after.callbacks),
            domWrites: add(add(visitWrites, offSteadyWrites), await takeWrites(page)),
            offSteadyWrites, offSteadyCallbacks,
          });
          continue;
        }
        await harness(page, (h) => h.trim());
        await settle(page, 200);
        const measured = await probe.end();
        visits.push({
          page: def.key, round, toggle: toggleKind, url: page.url(), growBatches: 7, ...measured,
          domWrites: add(visitWrites, await takeWrites(page)), offSteadyWrites, offSteadyCallbacks,
        });
      }
      await checkpoint();
    }

    log("end scenario");
    if (MODE === "full") await runScenario("end");

    // Still works at the end: every switch on, targets hidden, ordinary content visible.
    const functional: SessionReport["functional"] = {};
    for (const entry of pages.values()) {
      const { def, page } = entry;
      await ensureTikTok(entry);
      if (page.url() !== def.url) await page.goto(def.url, { waitUntil: def.tiktok ? "commit" : "load" });
      if (def.tiktok) await ensureTikTok(entry);
      functional[def.key] = {
        targetHidden: def.target ? await page.locator(def.target).isHidden() : null,
        keepVisible: await page.locator(def.keep).isVisible(),
      };
    }

    const loadAtEnd = loadavg()[0]!;
    const loaded = Math.max(loadAtStart, loadAtEnd) > MAX_LOAD;
    const TIMING_ADVISORY = TIMING_REQUESTED_ADVISORY || loaded;
    const verdicts = evaluate(scenarios, visits, checkpoints, functional);
    const failed = verdicts.filter((v) => v.status === "fail" && !(TIMING_ADVISORY && TIMING_CHECKS.has(v.check)));
    const finishedAt = new Date();
    const report: SessionReport = {
      harness: "still-sustained-session",
      version: 1,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      mode: MODE,
      control: CONTROL,
      requestedMinutes: MINUTES,
      actualMinutes: Math.round(((finishedAt.getTime() - startedAt.getTime()) / 60_000) * 100) / 100,
      rounds: round,
      environment: {
        browser: `chromium ${context.browser()?.version() ?? (await options.evaluate(() => navigator.userAgent))}`,
        platform: `${process.platform} ${process.arch}`,
        node: process.version,
        extension: CONTROL ? `disposable copy of the built artifact with control "${CONTROL}"` : "disposable copy of the built artifact (unchanged)",
        artifactSha256: shippingHash,
        cpuSlowdown: `${CP013.cpuSlowdown}x`,
        cpus: String(cpus().length),
        loadAverage1mStart: loadAtStart.toFixed(1),
        loadAverage1mEnd: loadAtEnd.toFixed(1),
        timingTrusted: loaded ? `no: load above ${MAX_LOAD}, timing checks are advisory` : "yes",
        tiktokReallowed: String(tiktokReallowed),
      },
      budgets: CP013,
      scenarios,
      visits,
      checkpoints,
      functional,
      verdicts,
      summary: {
        pass: verdicts.filter((v) => v.status === "pass").length,
        fail: verdicts.filter((v) => v.status === "fail").length,
        baseline: verdicts.filter((v) => v.status === "baseline").length,
        timingAdvisory: TIMING_ADVISORY,
        failed: failed.map((v) => `${v.check} ${v.page}: ${v.measured} (budget ${v.budget})`),
      },
      rulings: RULINGS,
      openQuestions: OPEN_QUESTIONS,
    };
    mkdirSync(dirname(REPORT), { recursive: true });
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nSustained session report: ${REPORT}`);
    if (loaded) log(`load average ${loadAtStart.toFixed(1)} → ${loadAtEnd.toFixed(1)} is above ${MAX_LOAD}: timing checks are advisory`);
    for (const v of verdicts) {
      const advisory = v.status === "fail" && TIMING_ADVISORY && TIMING_CHECKS.has(v.check) ? " (advisory)" : "";
      console.log(`  [${v.status.toUpperCase()}${advisory}] ${v.check} — ${v.page}: ${v.measured}`);
    }
    expect(failed.map((v) => `${v.check} ${v.page}: ${v.measured}`), "gated checks").toEqual([]);
  } finally {
    await context.close();
    await copy.remove();
    expect(await artifactHash(BUILT), "the built artifact is never modified").toBe(shippingHash);
  }
});

function add(a: DomWrites, b: DomWrites): DomWrites {
  return {
    attributes: a.attributes + b.attributes,
    childList: a.childList + b.childList,
    characterData: a.characterData + b.characterData,
    rootClass: a.rootClass + b.rootClass,
    nodesAdded: a.nodesAdded + b.nodesAdded,
    nodesRemoved: a.nodesRemoved + b.nodesRemoved,
  };
}

function mergeProfiles(...parts: VisitResult["profile"][]): VisitResult["profile"] {
  return {
    totalMs: r2(parts.reduce((n, p) => n + p.totalMs, 0)),
    maxSliceMs: Math.max(...parts.map((p) => p.maxSliceMs)),
    maxSliceTop: parts.reduce((a, b) => (b.maxSliceMs > a.maxSliceMs ? b : a)).maxSliceTop,
    slicesOver4Ms: parts.reduce((n, p) => n + p.slicesOver4Ms, 0),
    slicesOver50Ms: parts.reduce((n, p) => n + p.slicesOver50Ms, 0),
    windowMs: r2(parts.reduce((n, p) => n + p.windowMs, 0)),
  };
}

function mergeCallbacks(...parts: VisitResult["callbacks"][]): VisitResult["callbacks"] {
  const out = structuredClone(parts[0]!);
  for (const p of parts.slice(1)) {
    out.count += p.count;
    out.totalMs = r2(out.totalMs + p.totalMs);
    out.maxMs = Math.max(out.maxMs, p.maxMs);
    out.over4Ms += p.over4Ms;
    out.over50Ms += p.over50Ms;
    out.pageLongTasks += p.pageLongTasks;
    for (const [kind, k] of Object.entries(p.byKind)) {
      const o = out.byKind[kind as keyof typeof out.byKind];
      o.count += k.count;
      o.totalMs = r2(o.totalMs + k.totalMs);
      o.maxMs = Math.max(o.maxMs, k.maxMs);
    }
  }
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
