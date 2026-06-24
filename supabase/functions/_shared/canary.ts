// Selector-health canary core (R12, D10). Fetches each service's representative page, runs the
// current rule set's selectors, and flags surfaces that stopped matching. Crucially it classifies
// login walls / consent / bot challenges / empty pages as INDETERMINATE — never a clean pass — and
// tracks persistent-indeterminate as its own alert so a login-walled service can't rot silently.

export interface CanaryPage {
  readonly status: number;
  readonly html: string;
}

export interface PageFetcher {
  fetch(url: string): Promise<CanaryPage | null>;
}

export interface HtmlMatcher {
  count(html: string, selector: string): number;
}

export interface Notifier {
  notify(message: string): Promise<void>;
}

/** Persisted across scheduled runs so we alert on transitions, not every run. */
export interface CanaryStateStore {
  getNumber(key: string): Promise<number>;
  setNumber(key: string, value: number): Promise<void>;
  getFlag(key: string): Promise<boolean>;
  setFlag(key: string, value: boolean): Promise<void>;
}

interface RuleSetLike {
  services: Record<string, { matches: string[]; surfaces: { id: string; action: string; selectors?: string[] }[] }>;
}

const MIN_HTML_BYTES = 300;
const BOT_OR_WALL_MARKERS = [
  "captcha",
  "are you a robot",
  "verify you are human",
  "unusual traffic",
  "enable javascript",
  "please wait while we verify",
  "accept all cookies",
  "log in to continue",
  "sign up to see",
];

export type PageClass = "ok" | "indeterminate";

/** Distinguish a usable page from a login wall / consent / bot challenge / empty page. */
export function classifyPage(page: CanaryPage | null): PageClass {
  if (!page || page.status !== 200) return "indeterminate";
  if (page.html.length < MIN_HTML_BYTES) return "indeterminate";
  const lower = page.html.toLowerCase();
  return BOT_OR_WALL_MARKERS.some((m) => lower.includes(m)) ? "indeterminate" : "ok";
}

/** Representative public page per service. Falls back to the service's first match host. */
const REPRESENTATIVE_URLS: Record<string, string> = {
  youtube: "https://www.youtube.com/",
  instagram: "https://www.instagram.com/explore/",
  facebook: "https://www.facebook.com/watch/",
  tiktok: "https://www.tiktok.com/explore",
};

function representativeUrl(serviceId: string, matches: string[]): string {
  if (REPRESENTATIVE_URLS[serviceId]) return REPRESENTATIVE_URLS[serviceId];
  const host = (matches[0] ?? "").replace(/^\*:\/\/\*\./, "https://").replace(/\/\*$/, "/");
  return host || `https://${serviceId}`;
}

export interface CanaryDeps {
  readonly fetcher: PageFetcher;
  readonly matcher: HtmlMatcher;
  readonly notifier: Notifier;
  readonly state: CanaryStateStore;
  /** Consecutive indeterminate runs before firing the manual-check alert. */
  readonly indeterminateThreshold?: number;
}

export interface CanaryReport {
  readonly broken: { service: string; surface: string }[];
  readonly unverifiable: { service: string; runs: number }[];
  readonly notifications: string[];
}

/** Run one canary pass over the rule set. Notifies once per newly-broken / newly-unverifiable. */
export async function runCanary(ruleSet: RuleSetLike, deps: CanaryDeps): Promise<CanaryReport> {
  const threshold = deps.indeterminateThreshold ?? 3;
  const report: CanaryReport = { broken: [], unverifiable: [], notifications: [] };

  const fire = async (message: string) => {
    report.notifications.push(message);
    await deps.notifier.notify(message);
  };

  for (const [serviceId, service] of Object.entries(ruleSet.services)) {
    const page = await deps.fetcher.fetch(representativeUrl(serviceId, service.matches));
    const svcKey = `svc:${serviceId}`;

    if (classifyPage(page) === "indeterminate") {
      const streak = (await deps.state.getNumber(svcKey)) + 1;
      await deps.state.setNumber(svcKey, streak);
      if (streak === threshold) {
        report.unverifiable.push({ service: serviceId, runs: streak });
        await fire(`Still canary: '${serviceId}' unverifiable for ${streak} consecutive runs — needs a manual check.`);
      }
      continue;
    }
    await deps.state.setNumber(svcKey, 0); // recovered to a usable page

    for (const surface of service.surfaces) {
      if (!surface.selectors || (surface.action !== "hide" && surface.action !== "remove")) continue;
      let matched = 0;
      for (const selector of surface.selectors) matched += deps.matcher.count(page!.html, selector);
      const surfKey = `surf:${serviceId}:${surface.id}`;
      if (matched === 0) {
        if (!(await deps.state.getFlag(surfKey))) {
          report.broken.push({ service: serviceId, surface: surface.id });
          await deps.state.setFlag(surfKey, true);
          await fire(`Still canary: selectors for '${serviceId}/${surface.id}' matched nothing — likely selector rot.`);
        }
      } else {
        await deps.state.setFlag(surfKey, false); // healthy / recovered
      }
    }
  }
  return report;
}

/** Production notifier: POST to the configured URL. Missing URL → log + no-op (never crash). */
export function createNotifier(url: string | undefined, doFetch: typeof fetch = fetch): Notifier {
  if (!url) {
    return {
      notify: (message) => {
        console.log(`[canary] (no SELECTOR_CANARY_NOTIFY_URL set) ${message}`);
        return Promise.resolve();
      },
    };
  }
  return {
    async notify(message) {
      try {
        await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: message }),
        });
      } catch (err) {
        console.error(`[canary] notify failed: ${String(err)}`);
      }
    },
  };
}
