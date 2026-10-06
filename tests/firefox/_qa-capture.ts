import type { Bidi } from "./_bidi.js";

// Firefox's own window snapshot, for 2x captures of the real extension.
//
// WebDriver BiDi refuses captureScreenshot, setViewport and input on extension pages ("The command
// does not support browsing contexts in privileged scope"), so a screenshot of a moz-extension://
// page has to come from Firefox's chrome scope instead: `drawSnapshot` on the page's window global,
// drawn to a canvas at scale 2. The toolbar popup is captured the same way, as the real panel that
// Firefox opens for the add-on (QA-P0 spike item 2). Nothing here changes product code, and it only
// runs against the throwaway profile that tests/firefox launches.
//
// Narrow tab pages: the window will not go below 500 CSS px wide, so a page that is narrower than
// that (the 420 px D14 frames) is framed by constraining the tab's <browser> element, which does
// change the page's layout viewport.

type Json = Record<string, unknown>;

export type Rect = { width: number; height: number };

export class FirefoxChrome {
  private constructor(
    private readonly bidi: Bidi,
    private readonly context: string,
  ) {}

  static async attach(bidi: Bidi): Promise<FirefoxChrome> {
    const tree = await bidi.send("browsingContext.getTree", {
      "moz:scope": "chrome",
    });
    const context = (tree.contexts as Json[])[0]?.context as string | undefined;
    if (!context) throw new Error("Firefox exposed no chrome-scope window");
    return new FirefoxChrome(bidi, context);
  }

  /** Run an expression in Firefox's browser window and return its (string, number or boolean) value. */
  async eval<T>(expression: string): Promise<T> {
    const reply = await this.bidi.send("script.evaluate", {
      expression,
      target: { context: this.context },
      awaitPromise: true,
      resultOwnership: "none",
    });
    if (reply.type === "exception")
      throw new Error(
        `chrome scope threw: ${JSON.stringify(reply.exceptionDetails).slice(0, 300)}`,
      );
    return reply.result?.value as T;
  }

  /**
   * Dark or light for every page, including the toolbar popup, whatever the host appearance is.
   * The toolbar panel follows the browser's own UI theme, not the page override, so the host's
   * macOS Dark mode would otherwise turn every "light" popup frame dark. Three prefs pin it:
   * `content-override` for pages (0 dark, 1 light, 2 follow the system), `ui.systemUsesDarkTheme`
   * (0 light, 1 dark) for the system appearance Firefox reads, and `browser.theme.toolbar-theme` /
   * `content-theme` (0 dark, 1 light, 2 system) for the toolbar, panels and popup content.
   */
  async setColorScheme(scheme: "light" | "dark"): Promise<void> {
    const dark = scheme === "dark";
    await this.eval(`(() => {
      Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override", ${dark ? 0 : 1});
      Services.prefs.setIntPref("ui.systemUsesDarkTheme", ${dark ? 1 : 0});
      Services.prefs.setIntPref("browser.theme.toolbar-theme", ${dark ? 0 : 1});
      Services.prefs.setIntPref("browser.theme.content-theme", ${dark ? 0 : 1});
      return true;
    })()`);
  }

  /**
   * Show the tab whose address contains `urlPart` at exactly `size` CSS px: the window is made big
   * enough and the page's <browser> element is pinned to the size, so the layout viewport is the size.
   */
  async frameTab(urlPart: string, size: Rect): Promise<void> {
    await this.eval(`(async () => {
      const tab = gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec.includes(${JSON.stringify(urlPart)}));
      if (!tab) throw new Error("no tab with " + ${JSON.stringify(urlPart)});
      document.documentElement.style.minWidth = "0";
      window.resizeTo(Math.max(500, ${size.width}), ${size.height} + 140);
      gBrowser.selectedTab = tab;
      const b = tab.linkedBrowser;
      b.style.cssText = "width:${size.width}px;min-width:${size.width}px;max-width:${size.width}px;height:${size.height}px;min-height:${size.height}px;max-height:${size.height}px;flex:none";
      await new Promise((r) => setTimeout(r, 700));
      return true;
    })()`);
    // The page itself must see exactly this viewport, or the picture is of a different layout.
    const tree = await this.bidi.send("browsingContext.getTree", {});
    const page = (tree.contexts as Json[]).find((c) =>
      String(c.url).includes(urlPart),
    );
    if (!page) throw new Error(`no page with ${urlPart} to measure`);
    const reply = await this.bidi.send("script.evaluate", {
      expression: "window.innerWidth + 'x' + window.innerHeight",
      target: { context: page.context as string },
      awaitPromise: true,
    });
    const seen = (reply.result as Json | undefined)?.value;
    if (seen !== `${size.width}x${size.height}`)
      throw new Error(
        `framed ${urlPart} at ${size.width}x${size.height} but the page sees ${seen}`,
      );
  }

  /** Put the tab back as Firefox laid it out. */
  async unframeTab(urlPart: string): Promise<void> {
    await this.eval(`(async () => {
      const tab = gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec.includes(${JSON.stringify(urlPart)}));
      if (tab) tab.linkedBrowser.style.cssText = "";
      return true;
    })()`);
  }

  private async png(expression: string): Promise<Buffer> {
    const url = await this.eval<string>(expression);
    if (!url.startsWith("data:image/png;base64,"))
      throw new Error(`snapshot did not return a PNG: ${url.slice(0, 80)}`);
    return Buffer.from(url.split(",")[1] ?? "", "base64");
  }

  /** A 2x PNG of the page in the tab whose address contains `urlPart`: `size` CSS px, from `y` CSS px down the page. */
  async snapshotTab(urlPart: string, size: Rect, scale = 2, y = 0): Promise<Buffer> {
    return await this.png(`(async () => {
      const tab = gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec.includes(${JSON.stringify(urlPart)}));
      if (!tab) throw new Error("no tab with " + ${JSON.stringify(urlPart)});
      gBrowser.selectedTab = tab;
      await new Promise((r) => setTimeout(r, 200));
      const wg = tab.linkedBrowser.browsingContext.currentWindowGlobal;
      const bitmap = await wg.drawSnapshot(new DOMRect(0, ${y}, ${size.width}, ${size.height}), ${scale}, "white");
      const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      return canvas.toDataURL("image/png");
    })()`);
  }

  /** Open Still's real toolbar popup (the panel Firefox shows) and wait for it to draw. */
  async openPopup(settleMs = 1500): Promise<void> {
    await this.eval(`(async () => {
      const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const ext = WebExtensionPolicy.getByID("still@chartash.com").extension;
      await ExtensionParent.apiManager.global.browserActionFor(ext).openPopup(window, true);
      await new Promise((r) => setTimeout(r, ${settleMs}));
      return true;
    })()`);
  }

  /** The popup's drawn size in CSS px. */
  async popupSize(): Promise<Rect> {
    const text = await this.eval<string>(`(() => {
      const b = document.querySelector("browser.webextension-popup-browser");
      if (!b) throw new Error("the popup is not open");
      const r = b.getBoundingClientRect();
      return JSON.stringify({ width: r.width, height: r.height });
    })()`);
    return JSON.parse(text) as Rect;
  }

  /** A 2x PNG of the open popup panel, at its own size. */
  async snapshotPopup(scale = 2): Promise<{ png: Buffer; size: Rect }> {
    const size = await this.popupSize();
    const png = await this.png(`(async () => {
      const b = document.querySelector("browser.webextension-popup-browser");
      const bitmap = await b.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(0, 0, ${size.width}, ${size.height}), ${scale}, "white");
      const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      return canvas.toDataURL("image/png");
    })()`);
    return { png, size };
  }

  async closePopup(): Promise<void> {
    await this.eval(`(async () => {
      document.querySelectorAll("panel").forEach((p) => { try { p.hidePopup(); } catch {} });
      return true;
    })()`);
  }
}

/** Width and height of a PNG from its header. */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
