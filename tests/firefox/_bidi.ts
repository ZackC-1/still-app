import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A deliberately small WebDriver BiDi client, built on Node's own WebSocket, that launches a real
// Firefox and loads the built extension as a temporary add-on. Playwright's Firefox is a patched
// build that cannot install add-ons, and Selenium or webdriverio would be a new dependency, so this
// talks the standard protocol directly. Everything it needs ships with Firefox itself.

export const EXTENSION_ID = "still@chartash.com";
// Firefox hides the extension's address behind a random id per profile. Pinning it lets a test open
// the popup and options pages by URL.
export const EXTENSION_UUID = "5a1c0de0-0000-4000-8000-000000000001";

const MAC_FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";

// An explicit FIREFOX_BIN is a promise about which browser to test, so a wrong path is an error and
// never a quiet fall back to some other Firefox (or a skip that reads as a pass).
export function findFirefox(): string | null {
  const chosen = process.env.FIREFOX_BIN;
  if (chosen) {
    if (!existsSync(chosen))
      throw new Error(
        `FIREFOX_BIN is set to "${chosen}", but nothing exists there`,
      );
    return chosen;
  }
  const candidates = [
    MAC_FIREFOX,
    "/usr/bin/firefox",
    "/usr/local/bin/firefox",
    "/snap/bin/firefox",
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

// Firefox and its throwaway profile must not outlive the test run, even when afterAll never runs
// (a crash, Ctrl-C, or a runner kill). Cleanup is synchronous so it can run inside exit handlers.
const live = new Set<{ child: ChildProcess; profile: string }>();
function reap(): void {
  for (const entry of live) {
    entry.child.kill("SIGKILL");
    rmSync(entry.profile, { recursive: true, force: true });
  }
  live.clear();
}
process.once("exit", reap);

// Signal handlers cannot run when the test runner is killed outright (Playwright's own workers are
// stopped that way). A tiny detached watchdog covers that case: once the owning process is gone it
// kills Firefox and deletes the profile.
const WATCHDOG = `
const [parent, child, profile] = process.argv.slice(1);
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const timer = setInterval(() => {
  if (alive(parent) && alive(child)) return;
  try { process.kill(Number(child), "SIGKILL"); } catch {}
  require("node:fs").rmSync(profile, { recursive: true, force: true });
  clearInterval(timer);
}, 1000);
`;
function startWatchdog(child: ChildProcess, profile: string): void {
  if (child.pid === undefined) return;
  spawn(
    process.execPath,
    ["-e", WATCHDOG, String(process.pid), String(child.pid), profile],
    {
      detached: true,
      stdio: "ignore",
    },
  ).unref();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    reap();
    process.kill(process.pid, signal);
  });
}

// BiDi replies are untyped JSON; each caller reads only the few fields it needs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

interface Message {
  id?: number;
  type?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Json;
  error?: string;
  message?: string;
}
type Listener = (params: Json) => void;

export class Bidi {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve(value: Json): void; reject(error: Error): void }
  >();
  private readonly listeners = new Map<string, Set<Listener>>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) =>
      this.onMessage(JSON.parse(String(event.data)) as Message),
    );
  }

  static async connect(url: string): Promise<Bidi> {
    const socket = new WebSocket(`${url}/session`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error(`could not reach Firefox at ${url}`)),
        { once: true },
      );
    });
    const client = new Bidi(socket);
    await client.send("session.new", { capabilities: {} });
    return client;
  }

  private onMessage(message: Message): void {
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.type === "error")
        waiter.reject(new Error(`${message.error}: ${message.message}`));
      else waiter.resolve(message.result ?? {});
    } else if (message.method) {
      for (const listener of this.listeners.get(message.method) ?? [])
        listener(message.params ?? {});
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Json> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: Listener): void {
    const set = this.listeners.get(method) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(method, set);
  }

  close(): void {
    this.socket.close();
  }
}

export interface FirefoxSession {
  bidi: Bidi;
  version: string;
  /** Close Firefox and delete its throwaway profile. */
  stop(): Promise<void>;
}

async function waitForEndpoint(child: ChildProcess): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error("Firefox did not report a BiDi endpoint within 60s")),
      60_000,
    );
    let log = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      const match = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(log);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Firefox exited early (code ${code}). Output:\n${log.slice(-2000)}`,
        ),
      );
    });
  });
}

export async function launchFirefox(binary: string): Promise<FirefoxSession> {
  const profile = mkdtempSync(join(tmpdir(), "still-firefox-"));
  const prefs: Record<string, string | number | boolean> = {
    "extensions.webextensions.uuids": JSON.stringify({
      [EXTENSION_ID]: EXTENSION_UUID,
    }),
    // Keep the throwaway browser quiet and offline-ish: no update, telemetry or first-run traffic.
    "app.update.enabled": false,
    "browser.shell.checkDefaultBrowser": false,
    "browser.startup.homepage_override.mstone": "ignore",
    "datareporting.policy.dataSubmissionEnabled": false,
    "datareporting.healthreport.uploadEnabled": false,
    "toolkit.telemetry.enabled": false,
    "browser.newtabpage.enabled": false,
    "extensions.update.enabled": false,
    "network.captive-portal-service.enabled": false,
    "network.connectivity-service.enabled": false,
    "services.settings.server": "http://127.0.0.1:9/",
    "browser.safebrowsing.malware.enabled": false,
    "browser.safebrowsing.phishing.enabled": false,
  };
  writeFileSync(
    join(profile, "user.js"),
    Object.entries(prefs)
      .map(
        ([key, value]) =>
          `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`,
      )
      .join("\n"),
  );
  const child = spawn(
    binary,
    [
      "-profile",
      profile,
      "-no-remote",
      "-headless",
      "--remote-debugging-port",
      "0",
      "--remote-allow-system-access",
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const entry = { child, profile };
  live.add(entry);
  startWatchdog(child, profile);
  try {
    const endpoint = await waitForEndpoint(child);
    const bidi = await Bidi.connect(endpoint);
    const status = await bidi.send("session.status");
    void status;
    return {
      bidi,
      version: await firefoxVersion(binary),
      stop: async () => {
        bidi.close();
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const force = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 5_000);
          child.once("exit", () => {
            clearTimeout(force);
            resolve();
          });
        });
        rmSync(profile, { recursive: true, force: true });
        live.delete(entry);
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
    live.delete(entry);
    throw error;
  }
}

async function firefoxVersion(binary: string): Promise<string> {
  const child = spawn(binary, ["--version"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  await new Promise((resolve) => child.once("exit", resolve));
  return out.trim();
}
