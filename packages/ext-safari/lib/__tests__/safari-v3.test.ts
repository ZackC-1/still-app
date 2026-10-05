import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { AtomicSettingsWriter, InMemoryStorageAdapter } from "@still/core/storage";
import {
  SAFARI_DESKTOP_POPUP_BROWSER,
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

  it("keeps DesktopPopup's D01 reference label pending an owner copy ruling", () => {
    expect(SAFARI_DESKTOP_POPUP_BROWSER).toBe("Chrome");
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

  it("signed out: nothing, and in particular no sign-in", () => {
    expect(appManagedPopupAccount({ ...signedIn, userId: null }, TEXT)).toBeUndefined();
    expect(appManagedSettingsSync({ ...signedIn, userId: null }, TEXT)).toEqual({});
  });
});
