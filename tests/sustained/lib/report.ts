// Budgets, verdicts and the JSON report of the sustained session.
//
// The V3 plan's approved synthetic targets (CP013, kept by CP018) are the only timing numbers: a
// feed grown to 5000 nodes over 25 scroll steps at a 4x CPU slowdown, with total content-script
// time at most 100 ms and each flush at most 4 ms. Inside that scenario "flush" is read as any single
// unit of content-script work (one callback or continuous slice). On format-2 pages hiding is a
// stylesheet, so the scenario produces no engine work at all; the legacy-engine TikTok tab must
// register work in the same scenario to prove the probe is live.
//
// Leaks are gated structurally, not by a plan number: after the whole session, including every
// Off/On, the extension may hold no more event listeners than after warm-up, its live observer
// objects may not keep growing, and its observers may not fire more often per feed batch. While Off,
// format-2 pages must do no work at all. Heap growth and DOM writes during ordinary use have no
// budget; they are recorded as a baseline.
import type { CallbackStats, Checkpoint, ProfileSlice } from "./probe.js";
import type { DomWrites } from "./main-world.js";
import { SESSION_PAGES } from "./pages.js";

const ENGINE = new Map(SESSION_PAGES.map((p) => [p.key, p.engine]));

export const CP013 = Object.freeze({
  nodes: 5000,
  scrollSteps: 25,
  cpuSlowdown: 4,
  totalContentScriptMs: 100,
  perFlushMs: 4,
});

export interface ScenarioResult {
  page: string;
  phase: "start" | "end";
  /** Which content engine the page runs ("format2" hides with a stylesheet). */
  engine: "format2" | "legacy";
  nodesReached: number;
  profile: ProfileSlice;
  callbacks: CallbackStats;
  domWrites: DomWrites;
}

export interface VisitResult {
  page: string;
  round: number;
  toggle: "none" | "global" | "service";
  url: string;
  /** Feed-growth batches the harness made in this visit (one DOM mutation burst each). */
  growBatches: number;
  profile: ProfileSlice;
  callbacks: CallbackStats;
  domWrites: DomWrites;
  /** Writes while Off had settled and the feed kept growing (null when nothing was turned off). */
  offSteadyWrites: DomWrites | null;
  /** Content-script callbacks while Off had settled and the feed kept growing. */
  offSteadyCallbacks: number | null;
}

export interface Verdict {
  check: string;
  page: string;
  status: "pass" | "fail" | "baseline";
  budget: string;
  measured: string;
  source: string;
}

export interface SessionReport {
  harness: "still-sustained-session";
  version: 1;
  startedAt: string;
  finishedAt: string;
  mode: "full" | "smoke";
  control: string | null;
  requestedMinutes: number;
  actualMinutes: number;
  rounds: number;
  environment: Record<string, string>;
  budgets: typeof CP013;
  scenarios: ScenarioResult[];
  visits: VisitResult[];
  checkpoints: Record<string, Checkpoint[]>;
  functional: Record<string, { targetHidden: boolean | null; keepVisible: boolean }>;
  verdicts: Verdict[];
  summary: { pass: number; fail: number; baseline: number; timingAdvisory: boolean; failed: string[] };
  rulings: string[];
  openQuestions: string[];
}

const PLAN = "V3 plan CP013/CP018 synthetic target";
const STRUCTURAL = "harness structural check (no growth after warm-up)";
const NO_BUDGET = "no plan budget: baseline only";

export function evaluate(
  scenarios: readonly ScenarioResult[],
  visits: readonly VisitResult[],
  checkpoints: Record<string, Checkpoint[]>,
  functional: SessionReport["functional"],
): Verdict[] {
  const verdicts: Verdict[] = [];
  for (const s of scenarios) {
    const label = `${s.page} (${s.phase})`;
    const idle = s.callbacks.count === 0 && s.profile.totalMs === 0;
    verdicts.push({
      check: "cp013-total-content-script",
      page: label,
      status: s.profile.totalMs <= CP013.totalContentScriptMs ? "pass" : "fail",
      budget: `<= ${CP013.totalContentScriptMs} ms`,
      measured: `${s.profile.totalMs} ms over ${s.nodesReached} nodes${
        s.engine === "format2" && idle ? " (format-2 hides with a stylesheet: the feed causes no engine work)" : ""}`,
      source: PLAN,
    });
    // The probe must be shown live: the legacy engine's observer has to register work in the same
    // scenario, or a zero on the format-2 pages could just mean the measurement saw nothing.
    if (s.engine === "legacy") {
      verdicts.push({
        check: "cp013-probe-live",
        page: label,
        status: s.callbacks.count > 0 ? "pass" : "fail",
        budget: "> 0 content-script callbacks measured on the legacy-engine page",
        measured: `${s.callbacks.count} callbacks (${s.callbacks.byKind.observer.count} observer, ${s.callbacks.byKind.flush.count} flush), ${s.profile.totalMs} ms`,
        source: STRUCTURAL,
      });
    }
    const perFlush = Math.max(s.callbacks.maxMs, s.profile.maxSliceMs);
    verdicts.push({
      check: "cp013-per-flush",
      page: label,
      status: perFlush <= CP013.perFlushMs ? "pass" : "fail",
      budget: `<= ${CP013.perFlushMs} ms per callback and per continuous slice`,
      measured: `callback max ${s.callbacks.maxMs} ms, slice max ${s.profile.maxSliceMs} ms`,
      source: PLAN,
    });
  }
  for (const [page, points] of Object.entries(checkpoints)) {
    if (points.length < 2) {
      verdicts.push({ check: "leak-checkpoints", page, status: "fail", budget: ">= 2 checkpoints", measured: `${points.length}`, source: STRUCTURAL });
      continue;
    }
    const first = points[0]!;
    const last = points[points.length - 1]!;
    verdicts.push({
      check: "listener-leak",
      page,
      status: last.listenerTotal <= first.listenerTotal ? "pass" : "fail",
      budget: `<= ${first.listenerTotal} (after warm-up)`,
      measured: `${last.listenerTotal} at end (${points.map((p) => p.listenerTotal).join(" → ")})`,
      source: STRUCTURAL,
    });
    // Live observer objects are counted through their JavaScript wrappers. An observer that only
    // the browser still references can lose its wrapper to a collection and reappear later, so a
    // single step up is noise; growth across the last two intervals is a leak.
    const counts = points.map((p) => p.observerTotal);
    const sustained = counts.length >= 3 && counts.at(-1)! > counts.at(-2)! && counts.at(-2)! > counts.at(-3)!;
    verdicts.push({
      check: "observer-leak",
      page,
      status: sustained || (counts.length < 3 && last.observerTotal > first.observerTotal) ? "fail" : "pass",
      budget: "no growth across the last two checkpoint intervals",
      measured: `${last.observerTotal} at end (${counts.join(" → ")})`,
      source: STRUCTURAL,
    });
    verdicts.push({
      check: "heap-growth",
      page,
      status: "baseline",
      budget: NO_BUDGET,
      measured: `${round(last.heapUsedMB - first.heapUsedMB)} MB (${first.heapUsedMB} → ${last.heapUsedMB} MB)`,
      source: NO_BUDGET,
    });
  }
  const byPage = new Map<string, VisitResult[]>();
  for (const v of visits) byPage.set(v.page, [...(byPage.get(v.page) ?? []), v]);
  for (const [page, list] of byPage) {
    // Observers still firing: content-script observer callbacks per feed-growth batch, first round
    // against last. Each extra observer that keeps observing adds about one callback per batch.
    const rate = (round: number) => {
      const r = list.filter((v) => v.round === round);
      return r.reduce((n, v) => n + v.callbacks.byKind.observer.count, 0) / Math.max(1, r.reduce((n, v) => n + v.growBatches, 0));
    };
    const rounds = [...new Set(list.map((v) => v.round))].sort((a, b) => a - b);
    const firstRate = rate(rounds[0]!);
    const lastRate = rate(rounds.at(-1)!);
    verdicts.push({
      check: "observer-callback-growth",
      page,
      status: rounds.length >= 2 && lastRate >= firstRate + 1 ? "fail" : "pass",
      budget: "< 1 more observer callback per feed batch in the last round than in the first",
      measured: `${round(firstRate)} → ${round(lastRate)} callbacks per batch (rounds ${rounds[0]} → ${rounds.at(-1)})`,
      source: STRUCTURAL,
    });
    const max = Math.max(...list.map((v) => Math.max(v.callbacks.maxMs, v.profile.maxSliceMs)));
    const long = list.reduce((n, v) => n + Math.max(v.callbacks.over50Ms, v.profile.slicesOver50Ms), 0);
    verdicts.push({
      check: "sustained-content-script-long-tasks",
      page,
      status: long === 0 ? "pass" : "fail",
      budget: "0 content-script slices of 50 ms or more",
      measured: `${long} (largest ${round(max)} ms)`,
      source: "harness structural check (long tasks during the session)",
    });
    const total = round(list.reduce((n, v) => n + v.profile.totalMs, 0));
    const window = round(list.reduce((n, v) => n + v.profile.windowMs, 0));
    verdicts.push({
      check: "sustained-content-script-time",
      page,
      status: "baseline",
      budget: NO_BUDGET,
      measured: `${total} ms in ${round(window / 1000)} s measured (${round((total / Math.max(window, 1)) * 100)}%)`,
      source: NO_BUDGET,
    });
    const writes = list.reduce((n, v) => n + v.domWrites.attributes + v.domWrites.childList + v.domWrites.characterData, 0);
    verdicts.push({ check: "dom-writes", page, status: "baseline", budget: NO_BUDGET, measured: `${writes} mutation records over ${list.length} visits`, source: NO_BUDGET });
    const off = list.filter((v) => v.offSteadyWrites);
    if (off.length) {
      const offWrites = off.reduce((n, v) => n + v.offSteadyWrites!.attributes + v.offSteadyWrites!.childList + v.offSteadyWrites!.characterData, 0);
      const offCallbacks = off.reduce((n, v) => n + (v.offSteadyCallbacks ?? 0), 0);
      const gated = ENGINE.get(page) === "format2";
      verdicts.push({
        check: "off-steady-state",
        page,
        status: !gated ? "baseline" : offWrites === 0 && offCallbacks === 0 ? "pass" : "fail",
        budget: gated
          ? "0 DOM writes and 0 content-script callbacks while Off (format-2 pages)"
          : "exempt: the legacy engine keeps observing while Off by design (baseline only)",
        measured: `${offWrites} DOM writes and ${offCallbacks} content-script callbacks while Off with the feed growing (${off.length} Off phases)`,
        source: gated ? "coordinator ruling 2026-10-05: Off is zero work on format-2 pages" : NO_BUDGET,
      });
    }
  }
  for (const [page, f] of Object.entries(functional)) {
    verdicts.push({
      check: "still-works-at-end",
      page,
      status: f.keepVisible && f.targetHidden !== false ? "pass" : "fail",
      budget: "target hidden and ordinary content visible after the session",
      measured: `target ${f.targetHidden === null ? "n/a" : f.targetHidden ? "hidden" : "VISIBLE"}, ordinary ${f.keepVisible ? "visible" : "HIDDEN"}`,
      source: "harness sanity",
    });
  }
  return verdicts;
}

export const TIMING_CHECKS = new Set(["cp013-total-content-script", "cp013-per-flush", "sustained-content-script-long-tasks"]);

/** Rulings already made on the questions this harness raised (coordinator, 2026-10-05). */
export const RULINGS = [
  "Heap growth stays a recorded baseline; there is no heap budget.",
  "The fifth page is the YouTube watch page.",
  "The 4 ms per-flush target applies only inside the plan's synthetic scenario; the session-wide check is a structural 50 ms long-task check.",
  "Off is zero work on format-2 pages: no DOM writes and no content-script callbacks while Off. The legacy-engine TikTok tab is exempt.",
];

export const OPEN_QUESTIONS = [
  "DOM writes during ordinary On use have no budget; they are recorded as a baseline.",
  "Leaks after stop(): the shipping build exposes no way to stop the content script from a page, so only Off is measured; stop() teardown stays covered by the format-2 shipping fixture spec.",
];

export const round = (n: number) => Math.round(n * 100) / 100;
