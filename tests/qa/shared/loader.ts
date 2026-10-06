import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";

// Chrome's own developer loader (Extensions.loadUnpacked / Extensions.uninstall over CDP) in one
// running browser. It is the only way to make a real install, update or removal inside a single
// profile: a --load-extension extension reports "install" on every browser start, and
// chrome.runtime.reload() disables the extension in this harness. Mirrors the helper in
// tests/playwright/first-run.spec.ts; keep them behaving the same.

export async function launchWithExtensionLoader(profile: string) {
  const proc = spawn(
    chromium.executablePath(),
    [
      "--headless=new",
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`browser did not start: ${output.slice(0, 500)}`)), 30_000);
    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`browser exited (${code}) before it started: ${output.slice(0, 500)}`));
    });
    proc.stderr!.on("data", (chunk) => {
      output += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolveEndpoint(match[1]!);
      }
    });
  });
  const browser = await chromium.connectOverCDP(endpoint);
  const session = await browser.newBrowserCDPSession();
  return {
    context: browser.contexts()[0]!,
    load: (path: string) =>
      session.send("Extensions.loadUnpacked" as never, { path } as never) as Promise<{ id: string }>,
    uninstall: (id: string) => session.send("Extensions.uninstall" as never, { id } as never),
    /** Waits for the browser process to exit, so its profile is no longer being written. */
    async close() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise((resolveExit) => proc.once("exit", resolveExit));
      await session.send("Browser.close" as never).catch(() => {});
      await browser.close().catch(() => {});
      const terminate = setTimeout(() => proc.kill(), 3_000);
      const forced = setTimeout(() => proc.kill("SIGKILL"), 8_000);
      await exited;
      clearTimeout(terminate);
      clearTimeout(forced);
    },
  };
}
