import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { flushSync, type Component } from "svelte";
import type { SafariSetupObservation } from "../../native/bridge.js";
import { DEFAULT_SETTINGS, type StillSettings } from "@still/shared-types";
import { AtomicSettingsWriter, requireModernSettings } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { parseStoredSettingsRecord } from "../../storage/settings-validation.js";
import { WKWebViewStorageAdapter, type StillBridgeWindow } from "../../storage/wkwebview-adapter.js";
import { NativeBridge } from "../../native/bridge.js";
import { UiController, type UiAnalytics } from "../controller.svelte.js";
import { STRINGS } from "../strings.js";
import { FIND_MY_PURCHASE_MAILTO, PRIVACY_POLICY_URL, SETUP_GUIDE_URL, SUPPORT_EMAIL } from "../config.js";
import { createDesktopPopupBinding } from "./desktop-popup-binding.js";
import { createAppAnalytics } from "../../analytics/apple-app.js";
import LegacyApp from "../App.svelte";
import { EntitlementCache } from "../../entitlement/cache.js";
import {
  appleSettingsCacheOptions,
  appleSettingsHelp,
  appleSettingsPlatform,
  appleSettingsRestore,
  appleSettingsSetup,
  createAppleSettingsRestore,
  SUPPORT_MAILTO,
  createAppleSettingsSync,
  APPLE_SETUP_OBSERVATION_DEADLINE_MS,
  observeAppleSetup,
  watchAppleSetup,
  appleSettingsToggleReporter,
  createAppleSettingsAuthority,
  openExternalLink,
  selectAppleSettingsMode,
  type AppleSettingsAccountSource,
} from "./apple-settings-host.js";

// The host component lives in packages/app-webview (the only bundle allowed to carry D04's global
// stylesheet). It is loaded by a computed path (as other cross-package tests here do) so core's
// typecheck stays inside its rootDir.
const HOST_PATH = resolve(import.meta.dirname, "../../../../app-webview/src/AppleSettingsHost.svelte");
const MAIN_PATH = resolve(import.meta.dirname, "../../../../app-webview/src/main.ts");
async function loadHost(): Promise<Component<Record<string, unknown>>> {
  const module = (await import(/* @vite-ignore */ HOST_PATH)) as { default: Component<Record<string, unknown>> };
  return module.default;
}

type NativeMessage = { kind: string; command?: string; path?: string; value?: boolean; updatedAt?: number };
/** One App Group authority behind the WK settings message shapes. */
interface SettingsBackend {
  readonly name: string;
  post(message: NativeMessage): Promise<unknown>;
  read(): Promise<ReturnType<typeof parseStoredSettingsRecord>>;
  close(): Promise<void>;
}

// A user who already saved choices (YouTube Off). Fresh installs (no record, or an unedited
// zero-stamp record) are covered by their own cases below.
const SAVED: StillSettings = { ...DEFAULT_SETTINGS, updatedAt: 21, services: { ...DEFAULT_SETTINGS.services, youtube: false } };

async function tsBackend(seed: StillSettings | null): Promise<SettingsBackend> {
  const storage = new InMemoryStorageAdapter(seed);
  const writer = new AtomicSettingsWriter(storage);
  return {
    name: "TS writer",
    // Like the native bridge, a refused command is a reply without a record, never a thrown error.
    post: (message) => answer(message).catch(() => ({ ok: false })),
    read: async () => storage.get(),
    close: async () => {},
  };
  async function answer(message: NativeMessage): Promise<unknown> {
    switch (message.kind) {
      case "get":
        return (await storage.get()) ?? "";
      case "settingsAtomic": {
        const command = JSON.parse(message.command!) as { action: string; ownership?: "unknown" };
        return command.action === "initialize" ? writer.initialize(command.ownership!) : null;
      }
      case "settingsIntent": {
        const committed = await writer.commit({ path: message.path as never, value: message.value!, updatedAt: message.updatedAt! });
        const { intentCommitted, ...record } = committed as typeof committed & { intentCommitted?: boolean };
        return { changed: intentCommitted === true, record };
      }
      default:
        return null;
    }
  }
}

// The compiled StillKit host used by storage/__tests__/atomic-settings.test.ts. CI runs on Linux,
// so the TS writer keeps every case covered there; on macOS the same cases also run on Swift.
const swift = { temporary: "", binary: "", count: 0 };
const darwin = process.platform === "darwin";
// Compile the host component once up front so the first rendering test is not timed on it.
beforeAll(async () => {
  await loadHost();
}, 60_000);
beforeAll(async () => {
  if (!darwin) return;
  swift.temporary = await mkdtemp(join(tmpdir(), "still-apple-host-native-"));
  swift.binary = join(swift.temporary, "writer");
  const root = resolve(import.meta.dirname, "../../../../..");
  await copyFile(resolve(import.meta.dirname, "../../storage/__tests__/support/atomic-settings-main.swift"), join(swift.temporary, "main.swift"));
  await promisify(execFile)("swiftc", [
    ...["StillSettings", "SharedSettingsStore", "SettingsBridge", "SettingsV2", "SettingsFieldOrder", "PackagedFeatureRegistry", "AtomicSettingsBacking", "AtomicSettingsRecord"]
      .map((name) => join(root, "apps/apple/StillKit/Sources/StillKit", `${name}.swift`)),
    join(swift.temporary, "main.swift"), "-module-cache-path", join(swift.temporary, "modules"), "-o", swift.binary,
  ]);
}, 120_000);
afterAll(async () => {
  if (swift.temporary) await rm(swift.temporary, { recursive: true, force: true });
});

async function swiftBackend(seed: StillSettings | null): Promise<SettingsBackend> {
  const child = spawn(swift.binary, [join(swift.temporary, `host-${++swift.count}`)], { stdio: ["pipe", "pipe", "pipe"] });
  const queue: { resolve: (value: string) => void; reject: (e: Error) => void }[] = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (value) => queue.shift()?.resolve(value));
  child.on("exit", () => queue.splice(0).forEach((p) => p.reject(new Error("native exited"))));
  const raw = (message: unknown) => new Promise<string>((resolveReply, reject) => {
    queue.push({ resolve: resolveReply, reject });
    child.stdin.write((typeof message === "string" ? message : JSON.stringify(message)) + "\n");
  });
  if (seed) await raw("replace:" + JSON.stringify({ settings: seed, syncMetadata: null }));
  const settingsKinds = ["get", "set", "settingsAtomic", "settingsIntent"];
  return {
    name: "compiled Swift",
    post: (message) => (settingsKinds.includes(message.kind) ? raw(message) : Promise.resolve(null)),
    read: async () => parseStoredSettingsRecord(await raw({ kind: "get" })),
    async close() {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((r) => child.once("exit", r));
      }
    },
  };
}

const BACKENDS: readonly (readonly [string, (seed: StillSettings | null) => Promise<SettingsBackend>])[] = [
  ["TS writer", tsBackend],
  ...(darwin ? [["compiled Swift", swiftBackend] as const] : []),
];

/** The WK port in front of a backend, with transport faults and an initialization gate. */
function port(
  backend: SettingsBackend,
  options: {
    failOnce?: string[];
    initialized?: Promise<void>;
    /** Replies for non-settings messages (restore, receiptStatus); a throw is a rejected post. */
    replies?: Record<string, () => Promise<unknown>>;
  } = {},
) {
  const failOnce = [...(options.failOnce ?? [])];
  const fail = new Set<string>();
  const messages: NativeMessage[] = [];
  const postMessage = vi.fn(async (message: NativeMessage): Promise<unknown> => {
    messages.push(message);
    if (message.kind === "settingsAtomic") await options.initialized;
    const once = failOnce.indexOf(message.kind);
    if (once >= 0) {
      failOnce.splice(once, 1);
      return null;
    }
    if (fail.has(message.kind)) return null;
    const reply = options.replies?.[message.kind];
    if (reply) return reply();
    return backend.post(message);
  });
  const win: StillBridgeWindow = { webkit: { messageHandlers: { still: { postMessage } } } };
  return { win, messages, fail, postMessage };
}

function analyticsDouble(enabled = true) {
  const setSharing = vi.fn(async (next: boolean) => next);
  const analytics: UiAnalytics = {
    track: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    sharing: async () => ({ enabled, noticeNeeded: false }),
    setSharing,
  };
  return { analytics, setSharing };
}

const opened: SettingsBackend[] = [];
async function composeAtomic(
  factory: (seed: StillSettings | null) => Promise<SettingsBackend> = tsBackend,
  options: Parameters<typeof port>[1] & { seed?: StillSettings | null } = {},
) {
  const backend = await factory(options.seed === undefined ? SAVED : options.seed);
  opened.push(backend);
  const native = port(backend, options);
  const adapter = new WKWebViewStorageAdapter(native.win);
  const cache = new SettingsCache(adapter, appleSettingsCacheOptions("atomic"));
  cache.watch();
  const hydrated = cache.hydrate();
  hydrated.catch(() => {});
  const authority = createAppleSettingsAuthority(cache, {
    native: new NativeBridge(native.win),
    initializer: adapter,
    hydration: cache.whenHydrated(),
  });
  const { analytics, setSharing } = analyticsDouble();
  const controller = new UiController({ cache, host: { canPurchase: true }, analytics });
  // The entry passes this same NativeBridge as the free-period Restore bridge.
  const bridge = new NativeBridge(native.win);
  return { backend, native, adapter, cache, authority, controller, setSharing, hydrated, bridge };
}

async function renderHost(f: Awaited<ReturnType<typeof composeAtomic>>, overrides: Record<string, unknown> = {}) {
  const Host = await loadHost();
  const open = vi.fn();
  const report = vi.fn();
  const view = render(Host, {
    props: {
      controller: f.controller,
      authority: f.authority,
      observeSetup: async () => null,
      help: appleSettingsHelp(open),
      restoreBridge: f.bridge,
      onCommittedToggle: report,
      ...overrides,
    },
  });
  return { view, open, report };
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((backend) => backend.close()));
});

describe("Apple settings mode rule", () => {
  it.each([
    ["true", undefined, undefined, true, "atomic"],
    ["true", "", "", true, "atomic"],
    ["true", "https://still-audit.invalid", undefined, true, "atomic"],
    ["true", undefined, undefined, false, "legacy"],
    // Missing configuration alone never selects atomic.
    [undefined, undefined, undefined, true, "legacy"],
    ["", undefined, undefined, true, "legacy"],
    ["1", undefined, undefined, true, "legacy"],
    ["TRUE", undefined, undefined, true, "legacy"],
    ["false", undefined, undefined, true, "legacy"],
    // Configured builds stay legacy even with the flag.
    ["true", "https://still-audit.invalid", "public-audit-placeholder", true, "legacy"],
    [undefined, "https://still-audit.invalid", "public-audit-placeholder", true, "legacy"],
  ] as const)("flag=%s url=%s key=%s port=%s -> %s", (atomicSettingsFlag, supabaseUrl, supabaseAnonKey, nativePort, mode) => {
    expect(selectAppleSettingsMode({ atomicSettingsFlag, supabaseUrl, supabaseAnonKey, nativePort })).toBe(mode);
  });

  it("keeps the legacy cache construction and gives atomic mode unknown ownership", () => {
    expect(appleSettingsCacheOptions("legacy")).toBeUndefined();
    expect(appleSettingsCacheOptions("atomic")).toEqual({ atomicOwnership: "unknown" });
  });

  it("entry: inline build-time pre-filter on the flag, one dynamic host import, held hydration", () => {
    const main = readFileSync(MAIN_PATH, "utf8");
    expect(main).toMatch(
      /import\.meta\.env\.VITE_APPLE_ATOMIC_SETTINGS === "true" &&\s*!\(import\.meta\.env\.VITE_SUPABASE_URL && import\.meta\.env\.VITE_SUPABASE_ANON_KEY\)\s*\?\s*selectAppleSettingsMode\(/,
    );
    expect(main).toContain('import("./AppleSettingsHost.svelte")');
    expect(main).not.toMatch(/^import[^;]*AppleSettingsHost/m);
    expect(main).not.toMatch(/AppleSettings\.svelte/);
    expect(main).not.toContain("VITE_MODERN_SETTINGS_SYNC_ENABLED");
    // The host mounts without waiting for a native setup read.
    expect(main).not.toMatch(/await[^;]*observeSafariSetup/);
    // Exactly the shipped legacy construction and hydration remain on the legacy branch.
    expect(main).toContain(": new SettingsCache(new WKWebViewStorageAdapter());");
    expect(main).toContain("else void cache.hydrate();");
    expect(main).toContain("void cache.hydrate().catch(() => {});");
    // D04 help opens through the anchor route; the free-period Restore uses the one native bridge.
    expect(main).toContain("help: appleSettingsHelp((url) => openExternalLink(url)),");
    expect(main).toContain("restoreBridge: bridge,");
    expect(main).not.toMatch(/location\.href/);
    const index = readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf8");
    expect(index).not.toMatch(/AppleSettings\.svelte/);
  });
});

describe.each(BACKENDS)("native settings authority (%s)", (_name, factory) => {
  it("atomic hydration initializes through native with unknown ownership; legacy reads only", async () => {
    const atomicBackend = await factory(SAVED);
    opened.push(atomicBackend);
    const atomic = port(atomicBackend);
    const cache = new SettingsCache(new WKWebViewStorageAdapter(atomic.win), appleSettingsCacheOptions("atomic"));
    await cache.hydrate();
    expect(atomic.messages.map((m) => m.kind)).toEqual(["settingsAtomic"]);
    expect(JSON.parse(atomic.messages[0]!.command!)).toEqual({ action: "initialize", ownership: "unknown" });
    expect(cache.currentRecord().atomic?.ownership).toBe("unknown");
    expect(requireModernSettings(cache.currentRecord()).services.youtube).toBe(false);

    const legacyBackend = await factory(SAVED);
    opened.push(legacyBackend);
    const legacy = port(legacyBackend);
    const legacyCache = new SettingsCache(new WKWebViewStorageAdapter(legacy.win), appleSettingsCacheOptions("legacy"));
    await legacyCache.hydrate();
    expect(legacy.messages.map((m) => m.kind)).toEqual(["get"]);
    expect(legacyCache.currentRecord().atomic).toBeUndefined();
  });

  it("commands go through the same cache and port; no second adapter", async () => {
    const f = await composeAtomic(factory);
    await f.hydrated;
    const before = f.native.messages.length;
    expect((await f.authority.binding.setService("instagram", false)).status).toBe("committed");
    expect(f.native.messages.slice(before)).toEqual([
      expect.objectContaining({ kind: "settingsIntent", path: "services.instagram", value: false }),
    ]);
    expect(requireModernSettings((await f.backend.read())!).services.instagram).toBe(false);
    expect(f.authority.binding.current().settings?.services.instagram).toBe(false);
    f.authority.stop();
  });

  it("holds without saved choices until committed authority arrives, then shows saved Off as saved", async () => {
    let initialize!: () => void;
    const initialized = new Promise<void>((r) => {
      initialize = r;
    });
    const f = await composeAtomic(factory, { initialized });
    await renderHost(f);
    expect(screen.queryByRole("switch", { name: "Still" })).toBeNull();
    expect(screen.queryByText("Still is active")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(STRINGS.sync.checking);
    initialize();
    await f.hydrated;
    await screen.findByText("Still is active");
    await fireEvent.click(screen.getByRole("button", { name: "YouTube Blocker" }));
    expect(screen.getByRole("switch", { name: "Still on YouTube" })).toHaveAttribute("aria-checked", "false");
    f.authority.stop();
  });

  it("commits toggles through the binding and reports only committed toggles", async () => {
    const f = await composeAtomic(factory);
    await f.hydrated;
    const { report } = await renderHost(f);
    await fireEvent.click(await screen.findByRole("switch", { name: "Still" }));
    await screen.findByText("Still is off");
    expect(requireModernSettings((await f.backend.read())!).globalOn).toBe(false);
    await waitFor(() => expect(report).toHaveBeenCalledWith({ enabled: false }));
    f.authority.stop();
  });

  it("leaves the displayed saved choice unchanged when native refuses a command", async () => {
    const f = await composeAtomic(factory);
    await f.hydrated;
    const { report } = await renderHost(f);
    f.native.fail.add("settingsIntent");
    await fireEvent.click(await screen.findByRole("switch", { name: "Still" }));
    await waitFor(() => expect(f.native.messages.some((m) => m.kind === "settingsIntent")).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("Still is active")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Still" })).toHaveAttribute("aria-checked", "true");
    expect(requireModernSettings((await f.backend.read())!).globalOn).toBe(true);
    expect(report).not.toHaveBeenCalled();
    f.authority.stop();
  });

  it("after failed initialization, Try again initializes again through the same writer, then shows saved choices", async () => {
    const f = await composeAtomic(factory, { failOnce: ["settingsAtomic"] });
    await expect(f.hydrated).rejects.toMatchObject({ reason: "native-atomic-unavailable" });
    await renderHost(f);
    expect(await screen.findByText("Settings are unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Still" })).toBeNull();
    const before = f.native.messages.length;
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Still is active");
    const retried = f.native.messages.slice(before);
    expect(retried[0]).toMatchObject({ kind: "settingsAtomic" });
    expect(JSON.parse(retried[0]!.command!)).toEqual({ action: "initialize", ownership: "unknown" });
    expect(retried.some((m) => m.kind === "get")).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "YouTube Blocker" }));
    expect(screen.getByRole("switch", { name: "Still on YouTube" })).toHaveAttribute("aria-checked", "false");
    // Commands now work through the same cache.
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await screen.findByText("Still is off");
    expect(requireModernSettings((await f.backend.read())!).globalOn).toBe(false);
    f.authority.stop();
  });

  it("a retry that fails again keeps the hold and never presents defaults", async () => {
    const f = await composeAtomic(factory, { failOnce: ["settingsAtomic"] });
    await expect(f.hydrated).rejects.toBeTruthy();
    f.native.fail.add("settingsAtomic");
    await renderHost(f);
    await fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
    expect(screen.getByText("Settings are unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Still" })).toBeNull();
    expect(screen.queryByText("Still is active")).toBeNull();
    f.authority.stop();
  });
});

describe.each(BACKENDS)("native first install and local edits (%s)", (_name, factory) => {
  it("fresh install with no saved record: initialization refuses, nothing is written, the screen holds, Try again re-attempts", async () => {
    const f = await composeAtomic(factory, { seed: null });
    await expect(f.hydrated).rejects.toMatchObject({ reason: "native-atomic-unavailable" });
    expect(await f.backend.read()).toBeNull();
    await renderHost(f);
    expect(await screen.findByText("Settings are unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Still" })).toBeNull();
    expect(screen.queryByText("Still is active")).toBeNull();
    const before = f.native.messages.length;
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
    const retried = f.native.messages.slice(before);
    expect(retried[0]).toMatchObject({ kind: "settingsAtomic" });
    expect(JSON.parse(retried[0]!.command!)).toEqual({ action: "initialize", ownership: "unknown" });
    expect(await f.backend.read()).toBeNull();
    expect(screen.getByText("Settings are unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Still" })).toBeNull();
    f.authority.stop();
  });

  it("an unedited zero-stamp record (an install that never changed a setting) initializes", async () => {
    const f = await composeAtomic(factory, { seed: DEFAULT_SETTINGS });
    await f.hydrated;
    const stored = (await f.backend.read())!;
    expect(stored.atomic?.ownership).toBe("unknown");
    expect(requireModernSettings(stored).globalOn).toBe(true);
    await renderHost(f);
    expect(await screen.findByText("Still is active")).toBeInTheDocument();
    f.authority.stop();
  });

  it("saves more than 64 local edits under unknown ownership directly, with no pause", async () => {
    const f = await composeAtomic(factory);
    await f.hydrated;
    for (let edit = 1; edit <= 70; edit++) {
      const outcome = await f.authority.binding.setGlobalOn(edit % 2 === 0);
      expect(outcome, `edit ${edit}`).toEqual({ status: "committed" });
    }
    const stored = (await f.backend.read())!;
    expect(stored.atomic?.ownership).toBe("unknown");
    expect(stored.atomic?.paused).toBeNull();
    expect(requireModernSettings(stored).globalOn).toBe(true);
    expect(f.authority.binding.current()).toMatchObject({ commandAvailability: "ready", reason: null });
    f.authority.stop();
  });
});

describe("no native port", () => {
  it("is never presented as saved defaults", async () => {
    const empty: StillBridgeWindow = {};
    expect(selectAppleSettingsMode({ atomicSettingsFlag: "true", supabaseUrl: undefined, supabaseAnonKey: undefined, nativePort: new NativeBridge(empty).available })).toBe("legacy");
    const cache = new SettingsCache(new WKWebViewStorageAdapter(empty));
    await cache.hydrate();
    expect(cache.legacyReadState().status).toBe("absent");
    const binding = createDesktopPopupBinding(cache, new EntitlementCache({ get: async () => null, set: async () => {}, subscribe: () => () => {} }));
    expect(binding.current().settings).toBeNull();
    // Even a forced atomic cache without a port holds rather than inventing choices.
    const adapter = new WKWebViewStorageAdapter(empty);
    const forced = new SettingsCache(adapter, appleSettingsCacheOptions("atomic"));
    await expect(forced.hydrate()).rejects.toMatchObject({ reason: "native-atomic-unavailable" });
    const held = createAppleSettingsAuthority(forced, { native: new NativeBridge(empty), initializer: adapter, hydration: forced.whenHydrated() });
    await held.recover();
    expect(held.binding.current().settings).toBeNull();
    expect(held.binding.current().commandAvailability).toBe("unavailable");
    binding.stop();
    held.stop();
  });
});

describe("D04 host", () => {
  it("mounts at once without waiting for the native setup read", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    await renderHost(f, { observeSetup: () => new Promise<SafariSetupObservation | null>(() => {}) });
    expect(await screen.findByText("Still is active")).toBeInTheDocument();
    f.authority.stop();
  });

  it("follows a later successful setup read for the Mac inventory", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    const reads: (SafariSetupObservation | null)[] = [null, { ...MAC, extensionStatus: "enabled" }];
    await renderHost(f, { observeSetup: async () => reads.shift() ?? null });
    await fireEvent.click(await screen.findByRole("button", { name: "Facebook Blocker" }));
    expect(screen.queryByText("Desktop sidebar ads")).toBeNull();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByText("Desktop sidebar ads")).toBeInTheDocument();
    f.authority.stop();
  });

  it("paid tier off: a plain Restore purchase link, but no Still Pro card, Buy or price; Pro rows are not owned", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    await renderHost(f);
    await screen.findByText("Still is active");
    expect(screen.queryByText("Get Still Pro")).toBeNull();
    expect(screen.queryByText(/Checking your Still Pro access/)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Restore purchase" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Restore purchase" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull();
    expect(screen.queryByText("Still Pro can't be bought here yet.")).toBeNull();
    expect(screen.queryByText("No account needed. Payment is handled by Apple.")).toBeNull();
    expect(screen.queryByText(/\$\d/)).toBeNull();
    expect(screen.queryByText("Purchased")).toBeNull();
    expect(screen.getByRole("heading", { name: "Settings sync" })).toBeInTheDocument();
    f.authority.stop();
  });

  it("renders the existing usage-sharing control, driven by the native consent setter, never the combined card", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    await renderHost(f);
    const usage = await screen.findByRole("switch", { name: STRINGS.usage.title });
    expect(usage).toHaveAttribute("aria-checked", "true");
    const title = document.getElementById("usage-sharing-title")!;
    expect(title).toHaveClass("row-title");
    expect(title.getAttribute("style")).toBe("font-size:calc(15px * var(--text-scale, 1));font-weight:600;");
    expect(screen.queryByText("Share email and usage data")).toBeNull();
    expect(screen.queryByText(/Share your email and usage data/)).toBeNull();
    await fireEvent.click(usage);
    expect(f.setSharing).toHaveBeenCalledWith(false);
    await waitFor(() => expect(usage).toHaveAttribute("aria-checked", "false"));
    f.authority.stop();
  });

  it("help: setup guide, support email and privacy open the shipped destinations", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    const { open } = await renderHost(f);
    await fireEvent.click(await screen.findByRole("button", { name: "Setup guide" }));
    await fireEvent.click(screen.getByRole("button", { name: "Contact support" }));
    await fireEvent.click(screen.getByRole("button", { name: "Privacy policy" }));
    expect(open.mock.calls).toEqual([[SETUP_GUIDE_URL], ["mailto:support@stillapp.fit"], [PRIVACY_POLICY_URL]]);
    expect(SETUP_GUIDE_URL).toBe("https://stillapp.fit/setup/");
    f.authority.stop();
  });

  it("Contact support reaches native as a user-activated anchor to exactly the support address", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    await renderHost(f, { help: appleSettingsHelp((url) => openExternalLink(url)) });
    await fireEvent.click(await screen.findByRole("button", { name: "Contact support" }));
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.getAttribute("href")).toBe("mailto:support@stillapp.fit");
    expect(clicked[0]!.target).toBe("_blank");
    expect(document.querySelector("a[hidden]")).toBeNull();
    f.authority.stop();
  });

  it("without an account in this build, sign-in is not offered", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    await renderHost(f);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeDisabled();
    f.authority.stop();
  });

  it("signed out with no Still Pro producer, the caption names blocking only", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    await renderHost(f);
    expect(await screen.findByText("Optional. Blocking works without an account.")).toBeInTheDocument();
    expect(screen.queryByText(/Blocking and Still Pro work without an account/)).toBeNull();
    f.authority.stop();
  });

  it("opens the existing code sign-in sheet when the controller has a sign-in path", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    const controller = new UiController({
      cache: f.cache,
      host: { canPurchase: true },
      auth: { requestCode: vi.fn(), verifyCode: vi.fn(), signOut: vi.fn() } as never,
    });
    await renderHost(f, { controller });
    await fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(controller.signInOpen).toBe(true);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    f.authority.stop();
  });

  async function signedIn() {
    const f = await composeAtomic();
    await f.hydrated;
    const controller = new UiController({
      cache: f.cache,
      host: { canPurchase: true },
      auth: { requestCode: vi.fn(), verifyCode: vi.fn(), signOut: vi.fn(), deleteAccount: vi.fn() } as never,
    });
    controller.userId = "user-1";
    controller.accountEmail = "person@example.com";
    const confirm = vi.spyOn(controller, "confirmDeleteAccount").mockResolvedValue();
    await renderHost(f, { controller });
    await fireEvent.click(await screen.findByRole("button", { name: "Delete account" }));
    const dialog = await screen.findByRole("dialog");
    return { f, controller, confirm, dialog };
  }

  it("an open delete confirmation survives routine sync-status changes", async () => {
    const { f, controller, confirm, dialog } = await signedIn();
    controller.pendingUpload = true;
    flushSync();
    controller.pendingUpload = false;
    controller.lastSyncedAt = 5;
    flushSync();
    controller.cloudReachable = false;
    flushSync();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Delete account" }));
    expect(confirm).toHaveBeenCalledOnce();
    f.authority.stop();
  });

  it("a new account revision with the same account still present kills the open confirmation", async () => {
    const { f, controller, confirm } = await signedIn();
    controller.accountRevision += 1;
    // Any routine reactive change re-derives the props; the revision is read at that moment.
    controller.lastSyncedAt = 7;
    flushSync();
    const dialog = screen.getByRole("dialog");
    const button = within(dialog).getByRole("button", { name: "Delete account" });
    expect(button).toBeDisabled();
    await fireEvent.click(button);
    expect(confirm).not.toHaveBeenCalled();
    f.authority.stop();
  });

  it("a sign-out and sign-in to the same account kills the open confirmation", async () => {
    const { f, controller, confirm } = await signedIn();
    controller.userId = null;
    controller.accountRevision += 1;
    flushSync();
    controller.userId = "user-1";
    controller.accountRevision += 1;
    flushSync();
    const dialog = screen.getByRole("dialog");
    const button = within(dialog).getByRole("button", { name: "Delete account" });
    expect(button).toBeDisabled();
    await fireEvent.click(button);
    expect(confirm).not.toHaveBeenCalled();
    f.authority.stop();
  });

  it("stops the binding, releases its listeners and the access watch when the host unmounts", async () => {
    const watch = EntitlementCache.prototype.watch;
    const unwatched = vi.fn();
    vi.spyOn(EntitlementCache.prototype, "watch").mockImplementation(function (this: EntitlementCache) {
      const release = watch.call(this);
      return () => {
        unwatched();
        release();
      };
    });
    const f = await composeAtomic();
    await f.hydrated;
    const stop = vi.spyOn(f.authority.binding, "stop");
    const subscribe = f.authority.binding.subscribe;
    const released = vi.fn();
    vi.spyOn(f.authority.binding, "subscribe").mockImplementation((listener) => {
      const unsubscribe = subscribe(listener);
      return () => {
        released();
        unsubscribe();
      };
    });
    const { view } = await renderHost(f);
    await screen.findByText("Still is active");
    view.unmount();
    expect(stop).toHaveBeenCalled();
    expect(released).toHaveBeenCalledTimes(1);
    expect(unwatched).toHaveBeenCalledTimes(1);
    expect(f.authority.binding.current().reason).toBe("stopped");
    const before = f.native.messages.length;
    expect((await f.authority.binding.setGlobalOn(false)).status).toBe("unavailable");
    await f.authority.recover();
    expect(f.native.messages.length).toBe(before);
  });
});

describe("usage sharing with the entry's real analytics wiring", () => {
  // Exactly the createAppAnalytics inputs app-webview/src/main.ts passes today: no permission,
  // privacy policy or commitPermission producer. The legacy Apple screen uses the same controller
  // path (toggleUsageSharing -> analytics.ui.setSharing), so D04 must behave identically.
  function wiring(reply: (message: { kind: string; enabled?: boolean }) => Promise<unknown> = async () => null) {
    const messages: { kind: string; enabled?: boolean }[] = [];
    const win: StillBridgeWindow = {
      webkit: { messageHandlers: { still: { postMessage: async (message: unknown) => {
        messages.push(message as { kind: string });
        return reply(message as { kind: string; enabled?: boolean });
      } } } },
    };
    const memory = new Map<string, unknown>();
    const analytics = createAppAnalytics({
      bridge: new NativeBridge(win),
      config: { key: "phc_public_test_key", host: "https://us.i.posthog.com" },
      store: { get: async (k) => memory.get(k) ?? null, set: async (k, v) => void memory.set(k, v) },
      identifyOnServer: () => Promise.resolve(),
    });
    return { analytics, messages };
  }

  it("has no readable sharing state, so neither the legacy nor the D04 screen shows the switch", async () => {
    const { analytics } = wiring();
    expect(await analytics.ui.sharing!()).toBeNull();
    const f = await composeAtomic();
    await f.hydrated;
    const controller = new UiController({ cache: f.cache, host: { canPurchase: true }, analytics: analytics.ui });
    await renderHost(f, { controller });
    await screen.findByText("Still is active");
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.usageSharing).toBeNull();
    expect(screen.queryByRole("switch", { name: STRINGS.usage.title })).toBeNull();
    expect(screen.queryByText(STRINGS.usage.notice)).toBeNull();
    expect(screen.queryByText("Share email and usage data")).toBeNull();
    cleanup();
    render(LegacyApp, { props: { controller } });
    expect(screen.queryByRole("switch", { name: STRINGS.usage.title })).toBeNull();
    f.authority.stop();
  });

  it("turning sharing on fails closed without writing native consent", async () => {
    const { analytics, messages } = wiring();
    expect(await analytics.ui.setSharing!(true)).toBe(false);
    expect(messages.filter((m) => m.kind === "setAnalyticsConsent")).toEqual([]);
  });

  it("turning sharing off writes native consent off and reads back off", async () => {
    const { analytics, messages } = wiring(async (m) => (m.kind === "setAnalyticsConsent" ? { enabled: m.enabled } : null));
    expect(await analytics.ui.setSharing!(false)).toBe(false);
    expect(messages.filter((m) => m.kind === "setAnalyticsConsent")).toEqual([{ kind: "setAnalyticsConsent", enabled: false }]);
  });

  it("a failed native write while turning off resolves (no throw) and reports off", async () => {
    const { analytics, messages } = wiring(async (m) => {
      if (m.kind === "setAnalyticsConsent") throw new Error("native down");
      return null;
    });
    await expect(analytics.ui.setSharing!(false)).resolves.toBe(false);
    expect(messages.some((m) => m.kind === "setAnalyticsConsent")).toBe(true);
  });
});

const MAC = { ok: true, platform: "macos", enableLocation: "safariExtensionSettings" } as const;
const IOS: SafariSetupObservation = { ok: true, platform: "ios", extensionStatus: "unknown", enableLocation: "settingsAppStillPage" };
const MAC_STEPS = ["Open Safari, then Settings, then Extensions.", "Turn on Still.", "Allow it on every website."];

describe("Safari setup card", () => {
  it("macOS disabled -> the approved card with exact steps and no invented action", () => {
    expect(appleSettingsSetup({ ...MAC, extensionStatus: "disabled" })).toEqual({
      title: "Turn on Still in Safari",
      detail: "Still works inside Safari. Your choices are saved and start working once it's on.",
      steps: MAC_STEPS,
      actionLabel: "Open Safari Settings",
    });
  });

  it.each([
    ["macOS enabled", { ...MAC, extensionStatus: "enabled" } as SafariSetupObservation],
    ["macOS unknown", { ...MAC, extensionStatus: "unknown" } as SafariSetupObservation],
    ["iOS", IOS],
    ["no observation", null],
  ])("%s -> no card", (_name, observation) => {
    expect(appleSettingsSetup(observation)).toBeUndefined();
  });

  it("a late, failed or missing native reply is treated as not observable", async () => {
    vi.useFakeTimers();
    try {
      const late = observeAppleSetup(() => new Promise<SafariSetupObservation | null>(() => {}));
      await vi.advanceTimersByTimeAsync(APPLE_SETUP_OBSERVATION_DEADLINE_MS);
      expect(await late).toBeNull();
      expect(appleSettingsSetup(await late)).toBeUndefined();
      expect(await observeAppleSetup(() => Promise.reject(new Error("down")))).toBeNull();
      const disabled = { ...MAC, extensionStatus: "disabled" } as SafariSetupObservation;
      expect(await observeAppleSetup(async () => disabled)).toBe(disabled);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches the foreground listener before the first read", async () => {
    const order: string[] = [];
    const add = vi.spyOn(document, "addEventListener").mockImplementation(function (this: Document, ...args: Parameters<Document["addEventListener"]>) {
      if (args[0] === "visibilitychange") order.push("listen");
      return EventTarget.prototype.addEventListener.apply(this, args);
    });
    const stop = watchAppleSetup(async () => {
      order.push("read");
      return null;
    }, vi.fn());
    expect(order).toEqual(["listen"]);
    await vi.waitFor(() => expect(order).toEqual(["listen", "read"]));
    stop();
    add.mockRestore();
  });

  it("reads at once and on return to the foreground, latest read wins, keeps platform on a blank read, and stops cleanly", async () => {
    const replies: Array<(value: SafariSetupObservation | null) => void> = [];
    const read = vi.fn(() => new Promise<SafariSetupObservation | null>((r) => replies.push(r)));
    const publish = vi.fn();
    const stop = watchAppleSetup(read, publish, document, 60_000);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    replies[1]!({ ...MAC, extensionStatus: "disabled" });
    replies[0]!({ ...MAC, extensionStatus: "enabled" });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith({ setup: appleSettingsSetup({ ...MAC, extensionStatus: "disabled" }), platform: "mac" });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    replies[2]!(null);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(publish).toHaveBeenLastCalledWith({ setup: undefined, platform: null });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    stop();
    replies[3]!({ ...MAC, extensionStatus: "disabled" });
    await new Promise((r) => setTimeout(r, 0));
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 0));
    expect(read).toHaveBeenCalledTimes(4);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("shows the approved Mac setup card only while native observes the extension off", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    let next: SafariSetupObservation | null = { ...MAC, extensionStatus: "disabled" };
    await renderHost(f, { observeSetup: async () => next });
    expect(await screen.findByRole("heading", { name: "Turn on Still in Safari" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(expect.arrayContaining(MAC_STEPS));
    expect(screen.getByRole("button", { name: "Open Safari Settings" })).toBeDisabled();
    next = { ...MAC, extensionStatus: "enabled" };
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Turn on Still in Safari" })).toBeNull());
    f.authority.stop();
  });
});

describe("account, restore, help and telemetry mapping", () => {
  function source(overrides: Partial<AppleSettingsAccountSource> = {}): AppleSettingsAccountSource {
    return {
      userId: null,
      accountEmail: null,
      accountRevision: 3,
      cloudReachable: true,
      pendingUpload: false,
      lastSyncedAt: null,
      retrySync: undefined,
      canSignIn: false,
      canDeleteAccount: false,
      deleteFlow: "idle",
      openSignIn: vi.fn(),
      signOut: vi.fn(async () => {}),
      confirmDeleteAccount: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it("signed out: sign-in only when a code path exists", () => {
    const sync = createAppleSettingsSync();
    expect(sync(source()).onSignIn).toBeUndefined();
    const s = source({ canSignIn: true });
    sync(s).onSignIn!();
    expect(s.openSignIn).toHaveBeenCalledOnce();
    expect(sync(s).account).toBeUndefined();
  });

  it("signed in: identity is the user id, revision the controller epoch, missing email stays missing", () => {
    const sync = createAppleSettingsSync();
    const s = source({ userId: "user-1", canDeleteAccount: true, lastSyncedAt: 5 });
    const props = sync(s);
    expect(props.account).toMatchObject({ address: "", identity: "user-1", revision: 3, confirmed: false, status: { tone: "success", text: STRINGS.sync.synced } });
    props.account!.onSignOut!();
    props.account!.onDeleteAccount!();
    expect(s.signOut).toHaveBeenCalledOnce();
    expect(s.confirmDeleteAccount).toHaveBeenCalledOnce();
    expect(sync(source({ userId: "u", accountEmail: "a@b.c" })).account?.address).toBe("a@b.c");
  });

  it("keeps the same operations across routine status changes and replaces them on a new revision", () => {
    const sync = createAppleSettingsSync();
    const s = source({ userId: "user-1", canDeleteAccount: true });
    const first = sync(s).account!;
    Object.assign(s, { pendingUpload: true, lastSyncedAt: 9, cloudReachable: false });
    const second = sync(s).account!;
    expect(second.status).not.toEqual(first.status);
    expect(second.onDeleteAccount).toBe(first.onDeleteAccount);
    expect(second.onSignOut).toBe(first.onSignOut);
    Object.assign(s, { accountRevision: 4 });
    const third = sync(s).account!;
    expect(third.onDeleteAccount).not.toBe(first.onDeleteAccount);
    first.onDeleteAccount!();
    expect(s.confirmDeleteAccount).not.toHaveBeenCalled();
    third.onDeleteAccount!();
    expect(s.confirmDeleteAccount).toHaveBeenCalledOnce();
  });

  it("operations bound to an earlier account revision do nothing", () => {
    const sync = createAppleSettingsSync();
    const s = source({ userId: "user-1", canDeleteAccount: true, retrySync: vi.fn(async () => {}), cloudReachable: false });
    const props = sync(s);
    (s as { accountRevision: number }).accountRevision = 4;
    props.account!.onSignOut!();
    props.account!.onDeleteAccount!();
    props.account!.status!.onAction!();
    expect(s.signOut).not.toHaveBeenCalled();
    expect(s.confirmDeleteAccount).not.toHaveBeenCalled();
    expect(s.retrySync).not.toHaveBeenCalled();
  });

  it("no delete without the capability or while deleting; status follows the operation", () => {
    const sync = createAppleSettingsSync();
    expect(sync(source({ userId: "u" })).account).not.toHaveProperty("onDeleteAccount");
    const deleting = sync(source({ userId: "u", canDeleteAccount: true, deleteFlow: "deleting" })).account!;
    expect(deleting.onDeleteAccount).toBeUndefined();
    expect(deleting.status).toEqual({ tone: "pending", text: STRINGS.account.deleting });
    expect(sync(source({ userId: "u", deleteFlow: "error" })).account!.status).toEqual({ tone: "failed", text: STRINGS.account.deleteError });
    const retry = vi.fn(async () => {});
    const unreachable = sync(source({ userId: "u", cloudReachable: false, retrySync: retry })).account!.status!;
    expect(unreachable).toMatchObject({ tone: "failed", text: STRINGS.sync.unreachable, actionLabel: STRINGS.sync.retry });
    unreachable.onAction!();
    expect(retry).toHaveBeenCalledOnce();
    expect(sync(source({ userId: "u", pendingUpload: true })).account!.status).toEqual({ tone: "pending", text: STRINGS.sync.syncing });
    expect(sync(source({ userId: "u" })).account!.status).toEqual({ tone: "pending", text: STRINGS.sync.checking });
  });

  it("restore appears only for an actual running Restore", () => {
    expect(appleSettingsRestore({ purchaseFlow: "restoring" })).toEqual({ state: "checking" });
    for (const purchaseFlow of ["idle", "failed", "restored-none", "purchasing"] as const)
      expect(appleSettingsRestore({ purchaseFlow })).toBeUndefined();
  });

  it("opens https links through a user-activated blank-target anchor and removes it", () => {
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    openExternalLink(PRIVACY_POLICY_URL);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.href).toBe(PRIVACY_POLICY_URL);
    expect(clicked[0]!.target).toBe("_blank");
    expect(clicked[0]!.rel).toBe("noopener noreferrer");
    expect(document.querySelector("a[hidden]")).toBeNull();
    openExternalLink("javascript:alert(1)");
    openExternalLink("http://example.com/");
    expect(clicked).toHaveLength(1);
    expect(appleSettingsHelp(vi.fn())).toEqual({
      onGuide: expect.any(Function),
      onSupport: expect.any(Function),
      onPrivacy: expect.any(Function),
    });
  });

  it("opens exactly mailto:support@stillapp.fit and no other mailto", () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.getAttribute("href")!);
    });
    expect(SUPPORT_MAILTO).toBe("mailto:support@stillapp.fit");
    expect(SUPPORT_MAILTO).toBe(`mailto:${SUPPORT_EMAIL}`);
    for (const refused of [
      "mailto:support@stillapp.fit?subject=Help",
      FIND_MY_PURCHASE_MAILTO,
      "mailto:someone@example.com",
      "mailto:support@stillapp.fit,someone@example.com",
      "mailto:support@stillapp.fit#x",
      "MAILTO:support@stillapp.fit",
      "mailto://support@stillapp.fit",
      " mailto:support@stillapp.fit",
    ])
      openExternalLink(refused);
    expect(clicked).toEqual([]);
    openExternalLink("mailto:support@stillapp.fit");
    expect(clicked).toEqual(["mailto:support@stillapp.fit"]);
    const open = vi.fn();
    appleSettingsHelp(open).onSupport!();
    expect(open).toHaveBeenCalledExactlyOnceWith("mailto:support@stillapp.fit");
  });

  it("reports existing toggle events and never throws from telemetry", () => {
    const track = vi.fn();
    const report = appleSettingsToggleReporter({ track });
    report({ enabled: false });
    report({ service: "tiktok", enabled: true });
    expect(track).toHaveBeenNthCalledWith(1, "global_toggled", { enabled: false, where: "app" });
    expect(track).toHaveBeenNthCalledWith(2, "service_toggled", { service: "tiktok", enabled: true, where: "app" });
    expect(() => appleSettingsToggleReporter({ track: () => { throw new Error("x"); } })({ enabled: true })).not.toThrow();
  });

  it("uses the Mac inventory only for a native Mac observation", () => {
    expect(appleSettingsPlatform({ ok: true, platform: "macos", extensionStatus: "enabled", enableLocation: "safariExtensionSettings" })).toBe("mac");
    expect(appleSettingsPlatform({ ok: true, platform: "ios", extensionStatus: "unknown", enableLocation: "settingsAppStillPage" })).toBe("ios");
    expect(appleSettingsPlatform(null)).toBe("ios");
  });
});

describe("free-period Restore purchase (owner decision 17)", () => {
  const RESTORED = "Still Pro is restored on this device.";
  const NOTHING = "No Still Pro purchase was found for this account.";
  const FAILED = "We couldn't finish checking. Nothing changed.";
  type Replies = Record<string, () => Promise<unknown>>;
  const json =
    (value: unknown) =>
    async (): Promise<unknown> =>
      JSON.stringify(value);

  /** Settings-affecting native message kinds; a restore must never send one. */
  const SETTINGS_KINDS = new Set(["get", "set", "settingsAtomic", "settingsIntent"]);

  async function restoreHost(replies: Replies) {
    const f = await composeAtomic(tsBackend, { replies });
    await f.hydrated;
    await renderHost(f);
    await screen.findByText("Still is active");
    const saved = await f.backend.read();
    const before = f.native.messages.length;
    const sentAfter = () => f.native.messages.slice(before).map((m) => m.kind);
    return { f, saved, sentAfter };
  }

  async function expectUnchanged(h: Awaited<ReturnType<typeof restoreHost>>) {
    expect(h.sentAfter().filter((kind) => SETTINGS_KINDS.has(kind))).toEqual([]);
    expect(await h.f.backend.read()).toEqual(h.saved);
    expect(screen.queryByText("Get Still Pro")).toBeNull();
    expect(screen.queryByText("Purchased")).toBeNull();
    expect(screen.queryByText(/\$\d/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Settings sync" })).toBeInTheDocument();
  }

  it("success: shows restored without changing saved settings or revealing paid UI", async () => {
    const h = await restoreHost({ restore: json({ entitled: true }) });
    await fireEvent.click(screen.getByRole("button", { name: "Restore purchase" }));
    expect(await screen.findByText(RESTORED)).toBeInTheDocument();
    expect(h.sentAfter()).toEqual(["restore"]);
    await expectUnchanged(h);
    expect(screen.getByRole("button", { name: "Restore purchase" })).toBeEnabled();
    h.f.authority.stop();
  });

  it("an entitled device receipt after a refused native restore is restored", async () => {
    const h = await restoreHost({
      restore: json({ entitled: false }),
      receiptStatus: json({ receipt: "entitled" }),
    });
    await fireEvent.click(screen.getByRole("button", { name: "Restore purchase" }));
    expect(await screen.findByText(RESTORED)).toBeInTheDocument();
    expect(h.sentAfter()).toEqual(["restore", "receiptStatus"]);
    await expectUnchanged(h);
    h.f.authority.stop();
  });

  it("nothing to restore: only after a receipt verified not entitled", async () => {
    const h = await restoreHost({
      restore: json({ entitled: false }),
      receiptStatus: json({ receipt: "verifiedNotEntitled" }),
    });
    await fireEvent.click(screen.getByRole("button", { name: "Restore purchase" }));
    expect(await screen.findByText(NOTHING)).toBeInTheDocument();
    expect(screen.queryByText(FAILED)).toBeNull();
    await expectUnchanged(h);
    h.f.authority.stop();
  });

  const FAILURES: [string, Replies & { restore: () => Promise<unknown> }][] = [
    ["the native restore rejects", { restore: () => Promise.reject(new Error("store down")) }],
    ["native refuses and the receipt has no signal", { restore: json({ entitled: false }), receiptStatus: json({ receipt: "noSignal" }) }],
    ["native gives no reply at all", { restore: async () => null, receiptStatus: async () => null }],
  ];
  it.each(FAILURES)("failure or unavailable (%s): couldn't finish, never nothing found; Try again restores", async (_name, replies) => {
    const outcomes: (() => Promise<unknown>)[] = [];
    const h = await restoreHost({ ...replies, restore: () => (outcomes.shift() ?? replies.restore)() });
    await fireEvent.click(screen.getByRole("button", { name: "Restore purchase" }));
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.queryByText(NOTHING)).toBeNull();
    expect(screen.getByRole("button", { name: "Restore purchase" })).toBeDisabled();
    await expectUnchanged(h);
    outcomes.push(json({ entitled: true }));
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(RESTORED)).toBeInTheDocument();
    expect(h.sentAfter().filter((kind) => kind === "restore")).toHaveLength(2);
    await expectUnchanged(h);
    h.f.authority.stop();
  });

  it("double tap: one native restore while the first is in flight", async () => {
    let finish!: (value: unknown) => void;
    const h = await restoreHost({ restore: () => new Promise((r) => (finish = r)) });
    const link = screen.getByRole("button", { name: "Restore purchase" });
    await fireEvent.click(link);
    await fireEvent.click(link);
    expect(await screen.findByText("Checking for Still Pro purchases…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore purchase" })).toBeDisabled();
    await fireEvent.click(screen.getByRole("button", { name: "Restore purchase" }));
    expect(h.sentAfter()).toEqual(["restore"]);
    finish(JSON.stringify({ entitled: true }));
    expect(await screen.findByText(RESTORED)).toBeInTheDocument();
    expect(h.sentAfter()).toEqual(["restore"]);
    h.f.authority.stop();
  });

  it("without a restore bridge there is no Restore link", async () => {
    const f = await composeAtomic();
    await f.hydrated;
    await renderHost(f, { restoreBridge: undefined });
    await screen.findByText("Still is active");
    expect(screen.queryByRole("button", { name: "Restore purchase" })).toBeNull();
    f.authority.stop();
  });
});

describe("createAppleSettingsRestore", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  function entry(bridge: { restore: () => Promise<boolean>; receiptStatus?: () => Promise<"entitled" | "verifiedNotEntitled" | "noSignal"> }, refreshAccess = vi.fn(async () => {})) {
    const published: unknown[] = [];
    const restore = vi.fn(bridge.restore);
    const receiptStatus = vi.fn(bridge.receiptStatus ?? (async () => "noSignal" as const));
    const handle = createAppleSettingsRestore({
      bridge: { restore, receiptStatus },
      refreshAccess,
      publish: (next) => published.push(next),
    });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    return { handle, published, restore, receiptStatus, refreshAccess, settle };
  }

  it("single flight: a second start while running does nothing", async () => {
    const pending = deferred<boolean>();
    const e = entry({ restore: () => pending.promise });
    e.handle.start();
    e.handle.start();
    expect(e.restore).toHaveBeenCalledOnce();
    pending.resolve(true);
    await e.settle();
    expect(e.published).toEqual([{ state: "checking" }, { state: "restored" }]);
    e.handle.start();
    expect(e.restore).toHaveBeenCalledTimes(2);
  });

  it("re-reads access through the entitlement path after every outcome, and survives its failure", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("held");
    });
    const e = entry({ restore: async () => false, receiptStatus: async () => "verifiedNotEntitled" }, refresh);
    e.handle.start();
    await e.settle();
    expect(refresh).toHaveBeenCalledOnce();
    expect(e.published).toEqual([{ state: "checking" }, { state: "nothing" }]);
  });

  it("maps outcomes to existing RestoreStatusCard states only", async () => {
    const cases = [
      [{ restore: async () => true }, "restored"],
      [{ restore: async () => false, receiptStatus: async () => "entitled" as const }, "restored"],
      [{ restore: async () => false, receiptStatus: async () => "verifiedNotEntitled" as const }, "nothing"],
      [{ restore: async () => false, receiptStatus: async () => "noSignal" as const }, "failed"],
      [{ restore: async () => false, receiptStatus: () => Promise.reject(new Error("x")) }, "failed"],
      [{ restore: () => Promise.reject(new Error("x")) }, "failed"],
    ] as const;
    for (const [bridge, state] of cases) {
      const e = entry(bridge);
      e.handle.start();
      await e.settle();
      expect(e.published.at(-1)).toMatchObject({ state });
      const last = e.published.at(-1) as { onAction?: () => void };
      expect(typeof last.onAction === "function").toBe(state === "failed");
    }
  });

  it("after stop, a late reply publishes nothing and start does nothing", async () => {
    const pending = deferred<boolean>();
    const e = entry({ restore: () => pending.promise });
    e.handle.start();
    e.handle.stop();
    pending.resolve(true);
    await e.settle();
    expect(e.published).toEqual([{ state: "checking" }]);
    e.handle.start();
    expect(e.restore).toHaveBeenCalledOnce();
  });
});
