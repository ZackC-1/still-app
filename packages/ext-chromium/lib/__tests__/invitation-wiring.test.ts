import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicSettingsWriter } from "@still/core/storage";
import {
  INVITATION_LEDGER_KEY,
  parseInvitationLedger,
} from "../../../core/src/invitations/index.js";
import { observeDirectControls, type DirectControlSurface } from "../../../core/src/ui/v3/direct-control-observer.js";
import { presentInvitation } from "../../../core/src/ui/v3/popup-invitation-flow.js";
import type { DesktopPopupCommandOutcome } from "../../../core/src/ui/v3/desktop-popup-binding.js";
import { chromeInvitationLedgerPort, createInvitationHost } from "../invitation-background.js";
import { invitationPort, reportDirectControl } from "../invitation-client.js";
import { ANALYTICS_MESSAGE_KIND } from "../analytics.js";

const ORIGIN = "chrome-extension://extid/";
afterEach(() => vi.unstubAllGlobals());

/** Popup and options pages, the background and a spy over every runtime message, wired together. */
function world(account: "signed-out" | "signed-in" = "signed-out") {
  const values: Record<string, unknown> = {};
  const area = {
    get: async (key: string) => { await Promise.resolve(); return key in values ? { [key]: structuredClone(values[key]) } : {}; },
    set: async (items: Record<string, unknown>) => { await Promise.resolve(); Object.assign(values, structuredClone(items)); },
  } as never;
  const writer = new AtomicSettingsWriter({ get: async () => null, set: vi.fn(), subscribe: () => () => {} });
  const host = createInvitationHost({
    port: chromeInvitationLedgerPort(writer.serializeLocalMutation.bind(writer), area),
    setupFinished: async () => true,
    account: async () => account,
    signInAvailable: true,
    now: () => Date.UTC(2026, 9, 5, 12),
    newInstallationId: () => "install-1",
  });
  const listener = host.listener("extid", ORIGIN);
  const sent: unknown[] = [];
  vi.stubGlobal("chrome", {
    // An ordinary (not private) popup window: an unknown answer would count as private.
    windows: { getCurrent: async () => ({ incognito: false }) },
    extension: { inIncognitoContext: false },
    runtime: {
      sendMessage: (message: unknown) => {
        sent.push(message);
        return new Promise(resolve => {
          if (!listener(message, { id: "extid", url: `${ORIGIN}popup.html` } as chrome.runtime.MessageSender, resolve)) resolve(undefined);
        });
      },
    },
  });
  return { sent, ledger: () => parseInvitationLedger(values[INVITATION_LEDGER_KEY]) };
}
const settle = () => new Promise(r => setTimeout(r, 10));

const binding = (outcome: DesktopPopupCommandOutcome): DirectControlSurface => ({
  setGlobalOn: async () => outcome,
  setService: async () => outcome,
  setFeature: async () => outcome,
});

describe("popup and options pages to the background ledger", () => {
  it("counts committed direct changes from either page and nothing else", async () => {
    const w = world();
    await presentInvitation(invitationPort, "opening-1", () => {});
    const failing: DesktopPopupCommandOutcome[] = [
      { status: "unavailable", reason: "write-failed" },
      { status: "rejected", reason: "inactive-or-unavailable" },
      { status: "rejected", reason: "invalid-input" },
      { status: "not-committed" },
    ];
    for (const outcome of failing) {
      const b = observeDirectControls(binding(outcome), reportDirectControl);
      await b.setService("youtube", false); await b.setGlobalOn(false); await b.setFeature("youtube.comments", true);
    }
    await settle();
    expect(w.ledger()).toMatchObject({ milestones: 0, sync: "idle" });
    const popup = observeDirectControls(binding({ status: "committed" }), reportDirectControl);
    const options = observeDirectControls(binding({ status: "committed" }), reportDirectControl);
    await popup.setService("youtube", false); await options.setFeature("youtube.comments", true); await popup.setGlobalOn(false);
    await settle();
    expect(w.ledger()).toMatchObject({ milestones: 3, sync: "earned" });
  });

  it("three signed-out toggles then a later opening shows the card through the real flow", async () => {
    const w = world();
    await presentInvitation(invitationPort, "opening-1", () => {});
    const popup = observeDirectControls(binding({ status: "committed" }), reportDirectControl);
    await popup.setService("youtube", false); await popup.setService("instagram", false); await popup.setGlobalOn(false);
    await settle();
    const shown: string[] = [];
    expect(await presentInvitation(invitationPort, "opening-2", r => shown.push(r.reservation.opening))).toBe(true);
    expect(shown).toEqual(["opening-2"]);
    expect(w.ledger()).toMatchObject({ sync: "consumed", shown: 1 });
    expect(await presentInvitation(invitationPort, "opening-3", r => shown.push(r.reservation.opening))).toBe(false);
  });

  it("signed-in users get nothing", async () => {
    const w = world("signed-in");
    await presentInvitation(invitationPort, "opening-1", () => {});
    const popup = observeDirectControls(binding({ status: "committed" }), reportDirectControl);
    await popup.setService("youtube", false); await popup.setService("instagram", false); await popup.setGlobalOn(false);
    await settle();
    expect(w.ledger()).toMatchObject({ milestones: 0 });
    expect(await presentInvitation(invitationPort, "opening-2", () => { throw new Error("shown"); })).toBe(false);
  });

  it("sends only ledger messages: no analytics event of any kind is produced", async () => {
    const w = world();
    await presentInvitation(invitationPort, "opening-1", () => {});
    const popup = observeDirectControls(binding({ status: "committed" }), reportDirectControl);
    await popup.setService("youtube", false); await popup.setService("instagram", false); await popup.setGlobalOn(false);
    await settle();
    await presentInvitation(invitationPort, "opening-2", () => {});
    const kinds = new Set(w.sent.map(m => (m as { kind: string }).kind));
    expect([...kinds]).toEqual(["still:invitation"]);
    expect(kinds.has(ANALYTICS_MESSAGE_KIND)).toBe(false);
    expect(JSON.stringify(w.sent)).not.toMatch(/sync_prompt|sign_in_started/);
  });
});
