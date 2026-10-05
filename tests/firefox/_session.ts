import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_UUID,
  findFirefox,
  launchFirefox,
  type Bidi,
  type FirefoxSession,
  type Json,
} from "./_bidi.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIREFOX_EXTENSION = resolve(
  HERE,
  "../../packages/ext-chromium/dist/firefox-mv3",
);
const FIXTURE_DIR = resolve(HERE, "../fixtures");

export function fixture(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), "utf8");
}

// The four services. Page and extension-page requests to these hosts are answered from a local
// fixture, and any other such request is refused, so pages never touch the real sites.
//
// BiDi interception does NOT see requests made by the extension's own background script. Nothing
// here stops the background from reaching a server, so the lane instead refuses to run against a
// build that has a sign-in or analytics server compiled in (see assertUnconfiguredBuild).
const SERVICE_HOST = /(^|\.)(youtube|instagram|facebook|tiktok)\.com$/;

// A configured build carries real Supabase or PostHog addresses. The unconfigured build only has a
// bare "*.supabase.co" host-pattern string, which is not a URL and does not match.
const CONFIGURED_SERVER = /https?:\/\/[^"'`\s]*(supabase\.(co|in)|posthog)/i;

function assertUnconfiguredBuild(): void {
  const background = readFileSync(
    resolve(FIREFOX_EXTENSION, "background.js"),
    "utf8",
  );
  const found = CONFIGURED_SERVER.exec(background);
  if (found) {
    throw new Error(
      `The Firefox build at ${FIREFOX_EXTENSION} has a server address compiled in (${found[0].slice(0, 60)}). ` +
        "The background script's own requests are not intercepted, so this lane would reach the network. " +
        "Rebuild with VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and VITE_POSTHOG_* blank.",
    );
  }
}

export type Router = (url: URL) => string | null;

export class StillFirefox {
  private route: Router = () => null;
  private constructor(private readonly session: FirefoxSession) {}

  get bidi(): Bidi {
    return this.session.bidi;
  }
  get firefoxVersion(): string {
    return this.session.version;
  }

  static async start(): Promise<StillFirefox> {
    const binary = findFirefox();
    if (!binary) throw new Error("Firefox not found");
    assertUnconfiguredBuild();
    const session = await launchFirefox(binary);
    const self = new StillFirefox(session);
    try {
      await self.install();
      await self.interceptNetwork();
    } catch (error) {
      await session.stop();
      throw error;
    }
    return self;
  }

  private async install(): Promise<void> {
    await this.bidi.send("webExtension.install", {
      extensionData: { type: "path", path: FIREFOX_EXTENSION },
    });
  }

  private async interceptNetwork(): Promise<void> {
    this.bidi.on("network.beforeRequestSent", (event) => {
      if (!event.isBlocked) return;
      void this.answer(event);
    });
    await this.bidi.send("session.subscribe", {
      events: ["network.beforeRequestSent"],
    });
    await this.bidi.send("network.addIntercept", {
      phases: ["beforeRequestSent"],
    });
  }

  private async answer(event: Json): Promise<void> {
    const requestId = event.request.request as string;
    const url = new URL(event.request.url as string);
    try {
      if (
        url.protocol === "moz-extension:" ||
        url.protocol === "about:" ||
        url.protocol === "data:"
      ) {
        await this.bidi.send("network.continueRequest", { request: requestId });
      } else if (SERVICE_HOST.test(url.hostname)) {
        const html = this.route(url);
        const isDocument =
          event.request.destination === "document" || event.navigation;
        await this.bidi.send("network.provideResponse", {
          request: requestId,
          statusCode: html !== null || isDocument ? 200 : 204,
          reasonPhrase: "OK",
          headers: [
            {
              name: "Content-Type",
              value: { type: "string", value: "text/html; charset=utf-8" },
            },
          ],
          body: {
            type: "string",
            value:
              html ?? (isDocument ? "<!doctype html><title>blank</title>" : ""),
          },
        });
      } else {
        await this.bidi.send("network.failRequest", { request: requestId });
      }
    } catch {
      // The request was cancelled by a navigation that replaced it; nothing to answer.
    }
  }

  /** Decide the HTML any service URL is answered with. Return null for "empty page". */
  serve(router: Router): void {
    this.route = router;
  }

  async openTab(url: string): Promise<Tab> {
    const created = await this.bidi.send("browsingContext.create", {
      type: "tab",
    });
    const tab = new Tab(this.bidi, created.context as string);
    await tab.goto(url);
    return tab;
  }

  /** The extension's own page, which has the `browser` APIs a popup would use. */
  async openExtensionPage(name: string): Promise<Tab> {
    return await this.openTab(`moz-extension://${EXTENSION_UUID}/${name}`);
  }

  async stop(): Promise<void> {
    await this.session.stop();
  }
}

export class Tab {
  constructor(
    private readonly bidi: Bidi,
    readonly context: string,
  ) {}

  async goto(url: string): Promise<void> {
    await this.bidi.send("browsingContext.navigate", {
      context: this.context,
      url,
      wait: "complete",
    });
  }

  async close(): Promise<void> {
    await this.bidi.send("browsingContext.close", { context: this.context });
  }

  /** Run an expression in the page and return its (JSON-able) value. */
  async evaluate<T>(expression: string): Promise<T> {
    const reply = await this.bidi.send("script.evaluate", {
      expression: `(async () => JSON.stringify(await (${expression})))()`,
      target: { context: this.context },
      awaitPromise: true,
      resultOwnership: "none",
    });
    if (reply.type === "exception")
      throw new Error(`page threw: ${reply.exceptionDetails?.text}`);
    const text = reply.result?.value as string | undefined;
    return (text === undefined ? undefined : JSON.parse(text)) as T;
  }

  url(): Promise<string> {
    return this.evaluate<string>("location.href");
  }

  count(selector: string): Promise<number> {
    return this.evaluate<number>(
      `document.querySelectorAll(${JSON.stringify(selector)}).length`,
    );
  }

  /** Present and actually drawn: not removed, not display:none, not zero-sized. */
  isVisible(selector: string): Promise<boolean> {
    return this.evaluate<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
    })()`);
  }

  /** Wait until `selector` matches exactly `n` elements (or, with a function, until it accepts the count). */
  async waitForCount(
    selector: string,
    expected: number | ((n: number) => boolean),
    timeoutMs = 10_000,
  ): Promise<number> {
    const accept =
      typeof expected === "number" ? (n: number) => n === expected : expected;
    return await this.waitFor(
      `${selector} count to be ${typeof expected === "number" ? expected : "accepted"}`,
      () => this.count(selector),
      accept,
      timeoutMs,
    );
  }

  /** Wait until `selector` is drawn (true) or not drawn (false). */
  async waitForVisible(
    selector: string,
    visible: boolean,
    timeoutMs = 10_000,
  ): Promise<void> {
    await this.waitFor(
      `${selector} visible=${visible}`,
      () => this.isVisible(selector),
      (v) => v === visible,
      timeoutMs,
    );
  }

  /**
   * Require a condition to hold at every sample across a window. This is how "Still left the page
   * alone" is proved: a single early read is true before Still has decided anything, so the window
   * is only meaningful after a positive sign that Still is running.
   */
  async holdsFor(
    label: string,
    read: () => Promise<boolean>,
    windowMs = 1_000,
  ): Promise<void> {
    const deadline = Date.now() + windowMs;
    let samples = 0;
    do {
      if (!(await read()))
        throw new Error(
          `${label} stopped holding after ${samples} good samples`,
        );
      samples++;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
  }

  /** Poll until the condition holds, so a content script that runs after load is given time. */
  async waitFor<T>(
    label: string,
    read: () => Promise<T>,
    accept: (value: T) => boolean,
    timeoutMs = 10_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;
    while (Date.now() < deadline) {
      last = await read();
      if (accept(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `timed out waiting for ${label}; last value: ${JSON.stringify(last)}`,
    );
  }
}
