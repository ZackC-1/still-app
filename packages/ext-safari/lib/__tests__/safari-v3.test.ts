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
  const URL = "https://still-audit.invalid", KEY = "public-audit-placeholder";
  it.each([
    // Unconfigured: the developer opt-in (the app's atomic-local mode), unchanged.
    ["true", undefined, undefined, undefined, true],
    ["true", undefined, "", "", true],
    ["true", undefined, URL, undefined, true],
    ["true", undefined, undefined, KEY, true],
    ["true", "true", undefined, undefined, true],
    [undefined, undefined, undefined, undefined, false],
    ["", undefined, undefined, undefined, false],
    ["1", undefined, undefined, undefined, false],
    ["TRUE", undefined, undefined, undefined, false],
    ["false", undefined, undefined, undefined, false],
    // The modern flag alone never selects V3 without configuration.
    [undefined, "true", undefined, undefined, false],
    [undefined, "true", URL, undefined, false],
    // Configured: only the modern sync flag exactly "true" (the app's atomic-cloud mode).
    [undefined, "true", URL, KEY, true],
    ["true", "true", URL, KEY, true],
    [undefined, undefined, URL, KEY, false],
    [undefined, "", URL, KEY, false],
    [undefined, "TRUE", URL, KEY, false],
    [undefined, "1", URL, KEY, false],
    [undefined, "false", URL, KEY, false],
    // The developer flag never selects anything for a configured build.
    ["true", undefined, URL, KEY, false],
  ] as const)("atomic=%s modern=%s url=%s key=%s -> %s", (atomicSettingsFlag, modernSyncFlag, supabaseUrl, supabaseAnonKey, v3) => {
    expect(selectSafariV3Build({ atomicSettingsFlag, modernSyncFlag, supabaseUrl, supabaseAnonKey })).toBe(v3);
  });

  it.each(["popup", "options"])("%s entry: inline build-time pre-filter on both opt-ins, one dynamic import, unchanged legacy branch", (page) => {
    const main = readFileSync(resolve(import.meta.dirname, `../../entrypoints/${page}/main.ts`), "utf8");
    // The pre-filter can only narrow: each branch needs its flag's exact "true" plus the matching
    // configuration, the same expression as the Apple app's entry (app-webview main.ts).
    expect(main).toMatch(
      /if \(\s*\(import\.meta\.env\.VITE_APPLE_ATOMIC_SETTINGS === "true" &&\s*!\(import\.meta\.env\.VITE_SUPABASE_URL && import\.meta\.env\.VITE_SUPABASE_ANON_KEY\)\) \|\|\s*\(import\.meta\.env\.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true" &&\s*import\.meta\.env\.VITE_SUPABASE_URL &&\s*import\.meta\.env\.VITE_SUPABASE_ANON_KEY\)\s*\)/,
    );
    expect(main).toContain("modernSyncFlag: import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED,");
    expect(main).toContain('import("./v3.js")');
    expect(main).not.toMatch(/^import[^;]*(v3|SafariV3)/m);
    if (page === "popup") expect(main).toMatch(/\nelse init\(\);\n?$/);
    else expect(main).toMatch(/\} else mount\(OptionsApp, \{ target: document\.getElementById\("app"\)! \}\);\n?$/);
  });

  it("the popup, settings page and background read the flags through the same pre-filter", () => {
    const read = (file: string) => readFileSync(resolve(import.meta.dirname, `../../entrypoints/${file}`), "utf8");
    const normalized = (text: string) => text.replace(/\s+/g, " ");
    const gate = '(import.meta.env.VITE_APPLE_ATOMIC_SETTINGS === "true" && !(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)) || (import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true" && import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)';
    for (const file of ["popup/main.ts", "options/main.ts", "background.ts"]) expect(normalized(read(file))).toContain(gate);
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

  it("passes DesktopPopup its required browser value and the approved Settings label", () => {
    expect(SAFARI_DESKTOP_POPUP_BROWSER).toBe("Chrome");
    expect(SAFARI_SETTINGS_LABEL).toBe("Still settings");
  });
});

describe("the app-owned account reaches every V3 Safari screen (U12-W4 risk 6)", () => {
  // core App.svelte's V3 branches (committed popup binding, settings host) build account actions
  // without consulting accountManagedByApp. Safari must never reach them: its V3 screens are the
  // separate app-managed hosts, and its legacy wrappers pass none of the props that enable them.
  it("the Safari legacy wrappers never hand App.svelte a V3 presentation", () => {
    for (const file of ["popup/PopupApp.svelte", "options/OptionsApp.svelte"]) {
      const source = readFileSync(resolve(import.meta.dirname, `../../entrypoints/${file}`), "utf8");
      const app = source.match(/<App\b[^>]*\/>/g) ?? [];
      expect(app, file).toHaveLength(1);
      // The props that enable App.svelte's V3 branches, by their real names in App.svelte.
      for (const prop of ["committedPopupBinding", "popupPresentation", "settingsPresentation"])
        expect(app[0], `${file}: ${prop}`).not.toContain(prop);
    }
    // Both legacy controllers are app-managed (the popup's is built in its entry), and neither asks
    // the controller factory for the committed binding that would feed those branches.
    for (const file of ["popup/main.ts", "options/OptionsApp.svelte"]) {
      const source = readFileSync(resolve(import.meta.dirname, `../../entrypoints/${file}`), "utf8");
      expect(source, file).toContain("accountManagedByApp: true");
      expect(source, file).not.toContain("onCommittedPopupBinding");
    }
    // The pinned names are the real App.svelte props and factory option, so a rename breaks this.
    const app = readFileSync(resolve(import.meta.dirname, "../../../core/src/ui/App.svelte"), "utf8");
    for (const prop of ["committedPopupBinding", "popupPresentation", "settingsPresentation"]) expect(app).toMatch(new RegExp(`\\b${prop}\\?:`));
    expect(readFileSync(resolve(import.meta.dirname, "../../../core/src/ui/extension-setup.ts"), "utf8")).toContain("readonly onCommittedPopupBinding?:");
    // The V3 composition marks the account app-owned, and the V3 hosts render it read-only.
    const runtime = readFileSync(resolve(import.meta.dirname, "../safari-v3-runtime.ts"), "utf8");
    expect(runtime).toContain("controller.accountManagedByApp = true;");
    expect(readFileSync(resolve(import.meta.dirname, "../../entrypoints/popup/SafariV3Popup.svelte"), "utf8")).toContain("appManagedPopupAccount(c, STRINGS.sync)");
    expect(readFileSync(resolve(import.meta.dirname, "../../entrypoints/options/SafariV3Options.svelte"), "utf8")).toContain("appManagedSettingsSync(c, STRINGS.sync)");
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
