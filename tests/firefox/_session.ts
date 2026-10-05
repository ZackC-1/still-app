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

// The four services. A request to any of these hosts is answered from a local fixture, and any other
// web request is refused, so the lane never touches the real sites and needs no network at all.
const SERVICE_HOST = /(^|\.)(youtube|instagram|facebook|tiktok)\.com$/;

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
