import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const src = (path: string) => readFileSync(join(ROOT, path), "utf8");
const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap(name => {
    const rel = join(dir, name);
    if (name === "__tests__" || name === "node_modules") return [];
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });

describe("who may touch the invitation ledger", () => {
  it("only the background module opens a ledger port; pages and the client send messages", () => {
    const owners = ["lib/invitation-background.ts", "entrypoints/background.ts"];
    const offenders = [...walk("entrypoints"), ...walk("lib")]
      .filter(file => /\.(ts|svelte)$/.test(file) && !owners.includes(file))
      .filter(file => /InvitationLedgerStore|serializedInvitationLedgerPort|InMemoryInvitationLedgerPort|INVITATION_LEDGER_KEY|InvitationLedgerPort/.test(src(file)));
    expect(offenders).toEqual([]);
  });

  it("the background composes the ledger with the settings authority's serialized queue", () => {
    const background = src("entrypoints/background.ts");
    expect(background).toMatch(/chromeInvitationLedgerPort\(order, chrome\.storage\.local\)/);
    expect(background).toMatch(/const order[^\n]*settingsAuthority\.serializeLocalMutation\(mutation\)/);
  });

  it("the ledger area is never read or written outside the background's serialized port", () => {
    const client = src("lib/invitation-client.ts");
    expect(client).not.toMatch(/chrome\.storage|browser\.storage/);
  });
});

describe("only builds that show the V3 screens carry any of this", () => {
  const guard = /!\(import\.meta\.env\.VITE_SUPABASE_URL && import\.meta\.env\.VITE_SUPABASE_ANON_KEY\) \|\|\s*import\.meta\.env\.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true"/;
  it.each(["entrypoints/background.ts", "entrypoints/popup/main.ts", "entrypoints/popup/PopupApp.svelte", "entrypoints/options/OptionsApp.svelte"])(
    "%s uses the inline build-time check that can only narrow to legacy",
    file => expect(src(file)).toMatch(guard),
  );
  it("the first-run page does not count its setup-time changes", () => {
    expect(src("entrypoints/first-run/main.ts")).not.toMatch(/observeDirectControls|invitation/i);
  });
});
