import { describe, expect, it } from "vitest";
import {
  presentInvitation,
  syncInvitationPresentation,
  type PopupInvitationPort,
  type PopupInvitationReservation,
} from "./popup-invitation-flow.js";
import { invitationVisible } from "./invitation-presentation.js";

const reserved: PopupInvitationReservation = {
  installation: "install-1",
  reservation: { kind: "sync", opening: "opening-1", generation: 4 },
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

describe("presentInvitation: commit before the card renders", () => {
  it("shows nothing until the commit has resolved true, in order reserve, commit, show", async () => {
    const log: string[] = [];
    const commit = deferred<boolean>();
    const port: PopupInvitationPort = {
      present: async () => { log.push("present"); return reserved; },
      commit: () => { log.push("commit"); return commit.promise; },
    };
    const done = presentInvitation(port, "opening-1", () => log.push("show"));
    await Promise.resolve(); await Promise.resolve();
    expect(log).toEqual(["present", "commit"]);
    commit.resolve(true);
    expect(await done).toBe(true);
    expect(log).toEqual(["present", "commit", "show"]);
  });

  it("never shows the card when the commit is rejected", async () => {
    const shown: unknown[] = [];
    const port: PopupInvitationPort = { present: async () => reserved, commit: async () => false };
    expect(await presentInvitation(port, "opening-1", r => shown.push(r))).toBe(false);
    expect(shown).toEqual([]);
  });

  it("never shows the card when the commit fails to answer", async () => {
    const shown: unknown[] = [];
    const port: PopupInvitationPort = { present: async () => reserved, commit: async () => { throw new Error("worker gone"); } };
    expect(await presentInvitation(port, "opening-1", r => shown.push(r))).toBe(false);
    expect(shown).toEqual([]);
  });

  it("does not commit or show when nothing was reserved or the reservation fails", async () => {
    const calls: string[] = [];
    const none: PopupInvitationPort = { present: async () => null, commit: async () => { calls.push("commit"); return true; } };
    expect(await presentInvitation(none, "o", () => calls.push("show"))).toBe(false);
    const broken: PopupInvitationPort = { present: async () => { throw new Error("x"); }, commit: async () => { calls.push("commit"); return true; } };
    expect(await presentInvitation(broken, "o", () => calls.push("show"))).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("syncInvitationPresentation", () => {
  const base = { installation: "i", opening: "o", surface: "chrome" as const, onSignIn: () => {}, onNotNow: () => {} };
  it("is a visible sync card while open and hidden once closed", () => {
    expect(invitationVisible(syncInvitationPresentation({ ...base, closed: false }))).toBe(true);
    expect(invitationVisible(syncInvitationPresentation({ ...base, closed: true }))).toBe(false);
  });
  it("routes Sign in and Not now to the supplied handlers", () => {
    const calls: string[] = [];
    const p = syncInvitationPresentation({ ...base, closed: false, onSignIn: () => calls.push("in"), onNotNow: () => calls.push("later") });
    p.accept!.request(); p.dismiss!.request();
    expect(calls).toEqual(["in", "later"]);
    expect(p.kind).toBe("sync");
  });
});
