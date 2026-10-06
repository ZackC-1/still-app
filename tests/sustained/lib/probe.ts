// CDP measurements of the content script on one page (one tab), attributed by script URL.
//
// - Content-script CPU time: the V8 sampling profiler. A sample counts when any frame on its stack
//   belongs to the extension (chrome-extension://<id>/...), so time inside DOM calls the content
//   script makes and promise continuations are included. Contiguous runs of such samples give the
//   longest uninterrupted slice of content-script work.
// - Callbacks: a devtools.timeline trace. Each top-level FunctionCall/EvaluateScript whose script
//   is the extension's, in this page's frame, is one unit of content-script work; its enclosing
//   task tells which kind it was (MutationObserver delivery, animation-frame flush, timer, event,
//   extension API reply).
// - Heap: Runtime.getHeapUsage after a forced GC (the renderer isolate: page and content script).
// - Leaks: event listeners the extension's scripts registered on window, document, navigation,
//   <html> and <body> (DOMDebugger.getEventListeners on handles from the extension's own isolated
//   world, which is the only world whose listeners it reports, mapped by scriptId), and the live
//   count of MutationObserver / IntersectionObserver / ResizeObserver objects in the extension's isolated
//   world (Runtime.queryObjects against that world's prototypes).
import type { CDPSession, Page } from "@playwright/test";

export interface ProfileSlice {
  /** Total content-script time in the window (ms). */
  totalMs: number;
  /** Longest uninterrupted content-script slice (ms). */
  maxSliceMs: number;
  slicesOver4Ms: number;
  slicesOver50Ms: number;
  windowMs: number;
  /** Where the longest slice spent its time: the leaf frames (function:line:column), largest first. */
  maxSliceTop: string[];
}

export type CallbackKind = "observer" | "flush" | "timer" | "event" | "extension-api" | "other" | "load";

export interface CallbackStats {
  count: number;
  totalMs: number;
  maxMs: number;
  over4Ms: number;
  over50Ms: number;
  byKind: Record<CallbackKind, { count: number; totalMs: number; maxMs: number }>;
  /** Renderer main-thread tasks of 50 ms or more in the window, whatever their cause. */
  pageLongTasks: number;
}

export interface Checkpoint {
  heapUsedMB: number;
  /** Extension listeners by "target:event type". */
  listeners: Record<string, number>;
  listenerTotal: number;
  observers: Record<string, number>;
  observerTotal: number;
}

type TraceEvent = {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  tid: number;
  pid: number;
  args?: { data?: { url?: string; frame?: string } };
};

const KEEP = new Set([
  "RunTask", "RunMicrotasks", "BlinkScheduler_PerformMicrotaskCheckpoint", "FireAnimationFrame",
  "TimerFire", "EventDispatch", "Receive mojo message", "FunctionCall", "EvaluateScript", "v8.compile",
]);
const CATEGORIES = ["devtools.timeline", "toplevel", "v8.execute", "disabled-by-default-devtools.timeline"];

const emptyKinds = (): CallbackStats["byKind"] => ({
  observer: { count: 0, totalMs: 0, maxMs: 0 },
  flush: { count: 0, totalMs: 0, maxMs: 0 },
  timer: { count: 0, totalMs: 0, maxMs: 0 },
  event: { count: 0, totalMs: 0, maxMs: 0 },
  "extension-api": { count: 0, totalMs: 0, maxMs: 0 },
  other: { count: 0, totalMs: 0, maxMs: 0 },
  load: { count: 0, totalMs: 0, maxMs: 0 },
});

export class PageProbe {
  private cdp!: CDPSession;
  private frameId = "";
  private isolatedContext: number | null = null;
  private trace: TraceEvent[] = [];
  private traceDone: Promise<unknown> | null = null;

  constructor(
    readonly page: Page,
    private readonly extensionOrigin: string,
    private readonly cpuSlowdown: number,
  ) {}

  async init(): Promise<void> {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Runtime.executionContextCreated", ({ context }) => {
      const aux = context.auxData as { type?: string; frameId?: string } | undefined;
      if (aux?.type === "isolated" && context.origin === this.extensionOrigin) this.isolatedContext = context.id;
    });
    this.cdp.on("Runtime.executionContextsCleared", () => (this.isolatedContext = null));
    await this.cdp.send("Runtime.enable");
    await this.cdp.send("Profiler.enable");
    await this.cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await this.cdp.send("Emulation.setCPUThrottlingRate", { rate: this.cpuSlowdown });
    await this.refreshFrame();
  }

  async refreshFrame(): Promise<void> {
    const { frameTree } = await this.cdp.send("Page.getFrameTree");
    this.frameId = frameTree.frame.id;
  }

  /** Start one measured window (profiler + trace). Windows never overlap across pages. */
  async begin(): Promise<void> {
    this.trace = [];
    const onData = ({ value }: { value: unknown[] }) => {
      for (const e of value as TraceEvent[]) if (KEEP.has(e.name) && e.ph === "X") this.trace.push(e);
    };
    this.cdp.on("Tracing.dataCollected", onData);
    this.traceDone = new Promise((resolve) =>
      this.cdp.once("Tracing.tracingComplete", () => {
        this.cdp.off("Tracing.dataCollected", onData);
        resolve(undefined);
      }),
    );
    await this.cdp.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: { includedCategories: CATEGORIES, recordMode: "recordAsMuchAsPossible" },
    });
    await this.cdp.send("Profiler.start");
  }

  async end(): Promise<{ profile: ProfileSlice; callbacks: CallbackStats }> {
    const { profile } = await this.cdp.send("Profiler.stop");
    await this.cdp.send("Tracing.end");
    await this.traceDone;
    return { profile: this.summarizeProfile(profile), callbacks: this.summarizeTrace() };
  }

  private isExtensionUrl(url: string | undefined): boolean {
    return !!url && url.startsWith(`${this.extensionOrigin}/`);
  }

  private summarizeProfile(profile: {
    nodes: { id: number; callFrame: { url: string }; children?: number[] }[];
    samples?: number[];
    timeDeltas?: number[];
    startTime: number;
    endTime: number;
  }): ProfileSlice {
    const parent = new Map<number, number>();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const inExt = new Map<number, boolean>();
    const resolve = (id: number): boolean => {
      const known = inExt.get(id);
      if (known !== undefined) return known;
      const node = byId.get(id)!;
      const p = parent.get(id);
      const value = this.isExtensionUrl(node.callFrame.url) || (p !== undefined && resolve(p));
      inExt.set(id, value);
      return value;
    };
    const samples = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];
    let total = 0, slice = 0, maxSlice = 0, over4 = 0, over50 = 0;
    let frames = new Map<string, number>();
    let maxFrames = frames;
    const close = () => {
      if (slice > 0) {
        if (slice > maxSlice) maxFrames = frames;
        maxSlice = Math.max(maxSlice, slice);
        if (slice > 4) over4++;
        if (slice >= 50) over50++;
      }
      slice = 0;
      frames = new Map();
    };
    for (let i = 0; i < samples.length; i++) {
      // A sample stands for the interval until the next one.
      const ms = (deltas[i + 1] ?? deltas[i] ?? 0) / 1000;
      if (resolve(samples[i]!)) {
        total += ms;
        slice += ms;
        const f = byId.get(samples[i]!)!.callFrame as { functionName?: string; url: string; lineNumber?: number; columnNumber?: number };
        const label = `${f.functionName || "(anonymous)"}${this.isExtensionUrl(f.url) ? "" : " [native/page]"}:${f.lineNumber ?? -1}:${f.columnNumber ?? -1}`;
        frames.set(label, (frames.get(label) ?? 0) + ms);
      } else close();
    }
    close();
    return {
      totalMs: round(total),
      maxSliceMs: round(maxSlice),
      slicesOver4Ms: over4,
      slicesOver50Ms: over50,
      windowMs: round((profile.endTime - profile.startTime) / 1000),
      maxSliceTop: [...maxFrames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${round(v)} ms`),
    };
  }

  private summarizeTrace(): CallbackStats {
    const events = this.trace;
    // This page's renderer main thread: the thread its frame's script events run on.
    const owned = events.filter((e) => e.args?.data?.frame === this.frameId);
    const threads = new Set(owned.map((e) => `${e.pid}:${e.tid}`));
    const onThread = events
      .filter((e) => threads.has(`${e.pid}:${e.tid}`) && e.dur !== undefined)
      .sort((a, b) => a.ts - b.ts || b.dur! - a.dur!);
    const stats: CallbackStats = { count: 0, totalMs: 0, maxMs: 0, over4Ms: 0, over50Ms: 0, byKind: emptyKinds(), pageLongTasks: 0 };
    const stack: TraceEvent[] = [];
    for (const e of onThread) {
      while (stack.length && stack[stack.length - 1]!.ts + stack[stack.length - 1]!.dur! <= e.ts) stack.pop();
      if (e.name === "RunTask" && stack.length === 0 && e.dur! >= 50_000) stats.pageLongTasks++;
      const isExt =
        (e.name === "FunctionCall" || e.name === "EvaluateScript" || e.name === "v8.compile") &&
        e.args?.data?.frame === this.frameId &&
        this.isExtensionUrl(e.args?.data?.url);
      const nestedInExt = stack.some((s) => (s as TraceEvent & { ext?: boolean }).ext);
      if (isExt && !nestedInExt) {
        const ms = e.dur! / 1000;
        const names = stack.map((s) => s.name);
        const kind: CallbackKind =
          e.name !== "FunctionCall" ? "load"
          : names.includes("FireAnimationFrame") ? "flush"
          // A function Blink calls from a microtask checkpoint is a MutationObserver delivery (or a
          // queueMicrotask callback); promise continuations never appear as FunctionCall.
          : names.includes("RunMicrotasks") ? "observer"
          : names.includes("TimerFire") ? "timer"
          : names.includes("EventDispatch") ? "event"
          : names.includes("Receive mojo message") ? "extension-api"
          : "other";
        const k = stats.byKind[kind];
        k.count++;
        k.totalMs += ms;
        k.maxMs = Math.max(k.maxMs, ms);
        if (kind !== "load") {
          stats.count++;
          stats.totalMs += ms;
          stats.maxMs = Math.max(stats.maxMs, ms);
          if (ms > 4) stats.over4Ms++;
          if (ms >= 50) stats.over50Ms++;
        }
      }
      (e as TraceEvent & { ext?: boolean }).ext = isExt;
      stack.push(e);
    }
    stats.totalMs = round(stats.totalMs);
    stats.maxMs = round(stats.maxMs);
    for (const k of Object.values(stats.byKind)) {
      k.totalMs = round(k.totalMs);
      k.maxMs = round(k.maxMs);
    }
    return stats;
  }

  /** Forced GC, then heap, extension listeners and live extension observers. */
  async checkpoint(): Promise<Checkpoint> {
    await this.cdp.send("HeapProfiler.collectGarbage");
    const { usedSize } = await this.cdp.send("Runtime.getHeapUsage");

    const scripts = new Map<string, string>();
    const onScript = (e: { scriptId: string; url: string }) => scripts.set(e.scriptId, e.url);
    this.cdp.on("Debugger.scriptParsed", onScript);
    await this.cdp.send("Debugger.enable");
    const listeners: Record<string, number> = {};
    try {
      // DOMDebugger reports only the listeners of the world the object handle belongs to, so the
      // targets are resolved inside the extension's isolated world (not Playwright's own world).
      for (const target of this.isolatedContext === null ? [] : ["window", "document", "navigation", "document.documentElement", "document.body"]) {
        const { result } = await this.cdp.send("Runtime.evaluate", { expression: target, contextId: this.isolatedContext!, objectGroup: "still-probe" });
        if (!result.objectId) continue;
        const { listeners: found } = await this.cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId });
        for (const l of found) {
          if (!this.isExtensionUrl(scripts.get(l.scriptId))) continue;
          const key = `${target.replace("document.documentElement", "html").replace("document.body", "body")}:${l.type}`;
          listeners[key] = (listeners[key] ?? 0) + 1;
        }
      }
    } finally {
      this.cdp.off("Debugger.scriptParsed", onScript);
      await this.cdp.send("Debugger.disable");
    }

    const observers: Record<string, number> = {};
    if (this.isolatedContext !== null) {
      for (const name of ["MutationObserver", "IntersectionObserver", "ResizeObserver"]) {
        const { result } = await this.cdp.send("Runtime.evaluate", {
          expression: `${name}.prototype`,
          contextId: this.isolatedContext,
          objectGroup: "still-probe",
        });
        if (!result.objectId) continue;
        const { objects } = await this.cdp.send("Runtime.queryObjects", { prototypeObjectId: result.objectId, objectGroup: "still-probe" });
        const { result: length } = await this.cdp.send("Runtime.callFunctionOn", {
          objectId: objects.objectId!,
          functionDeclaration: "function () { return this.length; }",
          returnByValue: true,
        });
        observers[name] = Number(length.value);
      }
    }
    await this.cdp.send("Runtime.releaseObjectGroup", { objectGroup: "still-probe" });
    const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
    return {
      heapUsedMB: round(usedSize / 1024 / 1024),
      listeners,
      listenerTotal: sum(listeners),
      observers,
      observerTotal: sum(observers),
    };
  }

  /** True when the extension's isolated world exists in this page (the content script ran). */
  hasContentScript(): boolean {
    return this.isolatedContext !== null;
  }
}

export const round = (n: number) => Math.round(n * 100) / 100;
