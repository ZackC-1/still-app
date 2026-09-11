import { assert, assertEquals } from "@std/assert";
import {
  runCanary,
  classifyPage,
  createNotifier,
  type CanaryStateStore,
  type HtmlMatcher,
  type Notifier,
  type PageFetcher,
  type CanaryPage,
} from "../_shared/canary.ts";

const ruleSet = {
  services: {
    youtube: {
      matches: ["*://*.youtube.com/*"],
      surfaces: [
        { id: "yt-sidebar", action: "hide", selectors: ["a.shorts"] },
        { id: "yt-shelf", action: "remove", selectors: ["ytd-reel-shelf-renderer"] },
        { id: "yt-redirect", action: "redirect" }, // no selectors → skipped
      ],
    },
  },
};

const goodPage: CanaryPage = { status: 200, html: `<html><body>${"x".repeat(500)}</body></html>` };
const wallPage: CanaryPage = { status: 200, html: "Please complete the captcha to continue." };

function okFetcher(page: CanaryPage | null): PageFetcher {
  return { fetch: () => Promise.resolve(page) };
}
function mockMatcher(present: Set<string>): HtmlMatcher {
  return { count: (_html, sel) => (present.has(sel) ? 1 : 0) };
}
function collect(msgs: string[]): Notifier {
  return { notify: (m) => (msgs.push(m), Promise.resolve()) };
}
function memState(): CanaryStateStore {
  const nums = new Map<string, number>();
  const flags = new Map<string, boolean>();
  return {
    getNumber: (k) => Promise.resolve(nums.get(k) ?? 0),
    setNumber: (k, v) => (nums.set(k, v), Promise.resolve()),
    getFlag: (k) => Promise.resolve(flags.get(k) ?? false),
    setFlag: (k, v) => (flags.set(k, v), Promise.resolve()),
  };
}
const allPresent = new Set(["a.shorts", "ytd-reel-shelf-renderer"]);

Deno.test("classifyPage flags walls/empty/non-200 as indeterminate", () => {
  assertEquals(classifyPage(goodPage), "ok");
  assertEquals(classifyPage(wallPage), "indeterminate");
  assertEquals(classifyPage({ status: 503, html: "x".repeat(500) }), "indeterminate");
  assertEquals(classifyPage({ status: 200, html: "tiny" }), "indeterminate");
  assertEquals(classifyPage(null), "indeterminate");
});

Deno.test("healthy markup → no flags, no notifications", async () => {
  const msgs: string[] = [];
  const report = await runCanary(ruleSet, { fetcher: okFetcher(goodPage), matcher: mockMatcher(allPresent), notifier: collect(msgs), state: memState() });
  assertEquals(report.broken.length, 0);
  assertEquals(msgs.length, 0);
});

Deno.test("a renamed selector → flags the surface and notifies", async () => {
  const msgs: string[] = [];
  const report = await runCanary(ruleSet, {
    fetcher: okFetcher(goodPage),
    matcher: mockMatcher(new Set(["ytd-reel-shelf-renderer"])), // a.shorts now matches nothing
    notifier: collect(msgs),
    state: memState(),
  });
  assertEquals(report.broken, [{ service: "youtube", surface: "yt-sidebar" }]);
  assertEquals(msgs.length, 1);
  assert(msgs[0]!.includes("yt-sidebar"));
});

Deno.test("login-wall HTML → indeterminate, NOT a clean pass", async () => {
  const msgs: string[] = [];
  const report = await runCanary(ruleSet, {
    fetcher: okFetcher(wallPage),
    matcher: mockMatcher(new Set()), // nothing matches, but the page is unusable
    notifier: collect(msgs),
    state: memState(),
  });
  assertEquals(report.broken.length, 0); // must not report selector rot on an unverifiable page
});

Deno.test("persistent indeterminate past threshold → manual-check alert, then a reminder every Nth run", async () => {
  const msgs: string[] = [];
  const state = memState();
  const deps = {
    fetcher: okFetcher(wallPage),
    matcher: mockMatcher(new Set()),
    notifier: collect(msgs),
    state,
    indeterminateThreshold: 3,
    indeterminateRepeatEvery: 4,
  };
  await runCanary(ruleSet, deps); // streak 1
  await runCanary(ruleSet, deps); // streak 2
  assertEquals(msgs.length, 0);
  const r3 = await runCanary(ruleSet, deps); // streak 3 → alert
  assertEquals(r3.unverifiable, [{ service: "youtube", runs: 3 }]);
  assertEquals(msgs.length, 1);
  await runCanary(ruleSet, deps); // streak 4 → quiet
  await runCanary(ruleSet, deps); // streak 5 → quiet
  await runCanary(ruleSet, deps); // streak 6 → quiet
  assertEquals(msgs.length, 1);
  const r7 = await runCanary(ruleSet, deps); // streak 7 → reminder
  assertEquals(r7.unverifiable, [{ service: "youtube", runs: 7 }]);
  assertEquals(msgs.length, 2);
});

Deno.test("a service that is unverifiable for a long time keeps asking, instead of going quiet", async () => {
  // The live state showed fifty-seven consecutive unverifiable runs on a single alert, which is
  // the same as no monitoring at all. At the shipped default a daily job reminds weekly.
  const msgs: string[] = [];
  const state = memState();
  const deps = { fetcher: okFetcher(wallPage), matcher: mockMatcher(new Set()), notifier: collect(msgs), state };
  for (let run = 0; run < 57; run++) await runCanary(ruleSet, deps);
  // Threshold run 3, then runs 10, 17, 24, 31, 38, 45, 52.
  assertEquals(msgs.length, 8);
});

Deno.test("notifies once per newly-broken surface (no repeats while still broken)", async () => {
  const msgs: string[] = [];
  const state = memState();
  const deps = { fetcher: okFetcher(goodPage), matcher: mockMatcher(new Set(["ytd-reel-shelf-renderer"])), notifier: collect(msgs), state };
  await runCanary(ruleSet, deps);
  await runCanary(ruleSet, deps);
  assertEquals(msgs.length, 1);
});

Deno.test("missing notify URL → no-op notifier resolves without crashing", async () => {
  await createNotifier(undefined).notify("hello");
});
