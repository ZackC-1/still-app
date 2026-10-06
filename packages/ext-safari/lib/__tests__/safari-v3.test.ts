import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { AtomicSettingsWriter, InMemoryStorageAdapter } from "@still/core/storage";
import {
  SAFARI_DESKTOP_POPUP_BROWSER,
  SAFARI_SETTINGS_LABEL,
  appManagedPopupAccount,
  appManagedSettingsSync,
  SAFARI_PHONE_MAX_SCREEN_WIDTH,
  safariPopupFillsSheet,
  safariPopupSurface,
  savedRecordIsAtomic,
  selectSafariV3Build,
} from "../safari-v3.js";

const TEXT = { unreachable: "u", syncing: "s", synced: "y", checking: "c" };
const signedIn = {
  userId: "00000000-0000-4000-8000-0000000000aa",
  accountEmail: "person@example.invalid",
  cloudReachable: true,
  pendingUpload: false,
  lastSyncedAt: 1,
  accountRevision: 3,
};

describe("Safari V3 build gate (mirrors the Apple app's D04 gate)", () => {
  it.each([
    ["true", undefined, undefined, true],
    ["true", "", "", true],
    ["true", "https://still-audit.invalid", undefined, true],
    ["true", undefined, "public-audit-placeholder", true],
    // Configured builds stay legacy even with the flag.
    ["true", "https://still-audit.invalid", "public-audit-placeholder", false],
    [undefined, undefined, undefined, false],
    ["", undefined, undefined, false],
    ["1", undefined, undefined, false],
    ["TRUE", undefined, undefined, false],
    ["false", undefined, undefined, false],
  ] as const)("flag=%s url=%s key=%s -> %s", (atomicSettingsFlag, supabaseUrl, supabaseAnonKey, v3) => {
    expect(selectSafariV3Build({ atomicSettingsFlag, supabaseUrl, supabaseAnonKey })).toBe(v3);
  });

  it.each(["popup", "options"])("%s entry: inline build-time pre-filter, one dynamic import, unchanged legacy branch", (page) => {
    const main = readFileSync(resolve(import.meta.dirname, `../../entrypoints/${page}/main.ts`), "utf8");
    expect(main).toMatch(
      /if \(\s*import\.meta\.env\.VITE_APPLE_ATOMIC_SETTINGS === "true" &&\s*!\(import\.meta\.env\.VITE_SUPABASE_URL && import\.meta\.env\.VITE_SUPABASE_ANON_KEY\)\s*\)/,
    );
    expect(main).toContain('import("./v3.js")');
    expect(main).not.toMatch(/^import[^;]*(v3|SafariV3)/m);
    if (page === "popup") expect(main).toMatch(/\nelse init\(\);\n?$/);
    else expect(main).toMatch(/\} else mount\(OptionsApp, \{ target: document\.getElementById\("app"\)! \}\);\n?$/);
  });
});

describe("V3 styles load only after the record gate chose V3", () => {
  it.each(["popup", "options"])("%s gate module imports no component or stylesheet; only its mount module does", (page) => {
    const read = (file: string) => readFileSync(resolve(import.meta.dirname, `../../entrypoints/${page}/${file}`), "utf8");
    const gate = read("v3.ts");
    expect(gate).not.toMatch(/^import[^;]*(\.svelte|\.css)/m);
    expect(gate).toContain('import("./v3-mount.js")');
    expect(read("v3-mount.ts")).toMatch(/^import SafariV3\w+ from "\.\/SafariV3\w+\.svelte";$/m);
    // The deciding call comes before the component module is requested.
    expect(gate.indexOf("decideSafariV3(")).toBeLessThan(gate.indexOf('import("./v3-mount.js")'));
  });
});

describe("Safari V3 runtime record gate", () => {
  it("only the app's atomic record selects V3", async () => {
    const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, globalOn: false, updatedAt: 1 });
    const legacy = await storage.get();
    expect(savedRecordIsAtomic(legacy)).toBe(false);
    expect(savedRecordIsAtomic(null)).toBe(false);
    expect(savedRecordIsAtomic(undefined)).toBe(false);
    const atomic = await new AtomicSettingsWriter(storage).initialize("unknown");
    expect(savedRecordIsAtomic(atomic)).toBe(true);
  });
});

describe("Safari popup surface", () => {
  it("macOS gets the desktop popup; iOS, iPadOS and unknown get the mobile popup", () => {
    expect(safariPopupSurface("mac")).toBe("desktop");
    expect(safariPopupSurface("ios")).toBe("mobile");
    expect(safariPopupSurface(undefined)).toBe("mobile");
    expect(safariPopupSurface("win")).toBe("mobile");
  });

  it("fills the width only for the iPhone sheet, never a content-sized popover", () => {
    // iPhone screens (portrait points): SE, 13 mini, 15, 15 Plus, 16 Pro Max.
    for (const width of [320, 375, 390, 393, 430, 440]) expect(safariPopupFillsSheet("mobile", width)).toBe(true);
    // iPad screens keep the fixed width: their popover is sized from the content, like the Mac's.
    for (const width of [744, 768, 820, 1024]) expect(safariPopupFillsSheet("mobile", width)).toBe(false);
    expect(SAFARI_PHONE_MAX_SCREEN_WIDTH).toBeLessThan(744);
    // The Mac popover, whatever the screen.
    expect(safariPopupFillsSheet("desktop", 375)).toBe(false);
    expect(safariPopupFillsSheet("desktop", 1440)).toBe(false);
    // Unknown or nonsense screens keep the fixed width.
    for (const width of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(safariPopupFillsSheet("mobile", width)).toBe(false);
  });

  it("passes DesktopPopup its required browser value and the approved Settings label", () => {
    expect(SAFARI_DESKTOP_POPUP_BROWSER).toBe("Chrome");
    expect(SAFARI_SETTINGS_LABEL).toBe("Still settings");
  });
});

describe("the Apple app owns the account on Safari", () => {
  const actionKeys = (value: unknown): string[] =>
    JSON.stringify(value, (_key, v) => (typeof v === "function" ? "[function]" : v)).match(/"(on[A-Z]\w*|retry)"/g) ?? [];

  it("signed in: account is shown read-only, with no account action of any kind", () => {
    const popup = appManagedPopupAccount(signedIn, TEXT);
    expect(popup).toEqual({ address: "person@example.invalid", status: { tone: "success", text: "y" } });
    const settings = appManagedSettingsSync(signedIn, TEXT);
    expect(settings.account).toMatchObject({ address: "person@example.invalid", identity: signedIn.userId, revision: 3, confirmed: false });
    for (const value of [popup, settings]) {
      expect(Object.values(value ?? {}).some((v) => typeof v === "function")).toBe(false);
      expect(actionKeys(value)).toEqual([]);
    }
  });

  it("status follows the app's reported sync state", () => {
    expect(appManagedPopupAccount({ ...signedIn, cloudReachable: false }, TEXT)?.status).toEqual({ tone: "failed", text: "u" });
    expect(appManagedPopupAccount({ ...signedIn, pendingUpload: true }, TEXT)?.status).toEqual({ tone: "pending", text: "s" });
    expect(appManagedPopupAccount({ ...signedIn, lastSyncedAt: null }, TEXT)?.status).toEqual({ tone: "pending", text: "c" });
  });

  it("signed out: no account display and, in particular, no sign-in", () => {
    expect(appManagedPopupAccount({ ...signedIn, userId: null }, TEXT)).toBeUndefined();
    // An empty account: SyncCard then shows neither its Sign in button nor any account action.
    expect(appManagedSettingsSync({ ...signedIn, userId: null }, TEXT)).toEqual({ account: { confirmed: false } });
  });
});
