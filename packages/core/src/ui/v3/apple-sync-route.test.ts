import { describe, expect, it, vi } from "vitest";
import { createAppleSyncRoute, revealAppleSyncCard } from "./apple-sync-route.js";
import type { NativeAppRoute } from "../../native/bridge.js";

function harness(pending: NativeAppRoute | null, signedOut = true) {
  const calls: string[] = [];
  const deps = {
    bridge: {
      pendingAppRoute: vi.fn(async () => pending),
      acknowledgeAppRoute: vi.fn(async (revision: number) => {
        calls.push(`ack:${revision}`);
        return true;
      }),
    },
    showSettings: vi.fn(() => void calls.push("settings")),
    canSignIn: vi.fn(() => signedOut),
    openSignIn: vi.fn(() => void calls.push("signIn")),
    reveal: vi.fn((focus: boolean) => void calls.push(`reveal:${focus}`)),
  };
  return { route: createAppleSyncRoute(deps), deps, calls };
}

describe("createAppleSyncRoute", () => {
  it("signed out: shows Settings, opens sign-in over the sync card, then acknowledges", async () => {
    const { route, calls } = harness({ route: "sync", revision: 4 });
    await route.route();
    expect(calls).toEqual(["settings", "signIn", "reveal:false", "ack:4"]);
  });

  it("signed in: shows the sync card with its status and opens nothing else", async () => {
    const { route, deps, calls } = harness({ route: "sync", revision: 2 }, false);
    await route.route();
    expect(deps.openSignIn).not.toHaveBeenCalled();
    expect(calls).toEqual(["settings", "reveal:true", "ack:2"]);
  });

  it("leaves the Still Pro route pending for the Pro host", async () => {
    const { route, deps } = harness({ route: "pro", revision: 9 });
    await route.route();
    expect(deps.showSettings).not.toHaveBeenCalled();
    expect(deps.openSignIn).not.toHaveBeenCalled();
    expect(deps.bridge.acknowledgeAppRoute).not.toHaveBeenCalled();
  });

  it("does nothing with no pending route or after stop", async () => {
    const empty = harness(null);
    await empty.route.route();
    expect(empty.calls).toEqual([]);
    const stopped = harness({ route: "sync", revision: 1 });
    stopped.route.stop();
    await stopped.route.route();
    expect(stopped.calls).toEqual([]);
  });
});

describe("revealAppleSyncCard", () => {
  function screen(headings: string[]) {
    const root = document.createElement("div");
    root.innerHTML = headings
      .map((text) => `<section class="card"><h2> ${text} </h2></section>`)
      .join("");
    const scrolled: string[] = [];
    root.querySelectorAll<HTMLElement>("section").forEach((section) => {
      section.scrollIntoView = () => void scrolled.push(section.textContent!.trim());
    });
    document.body.replaceChildren(root);
    return { root, scrolled };
  }

  it("scrolls to the Settings sync card and focuses it when no sheet is open", () => {
    const { root, scrolled } = screen(["Still Pro", "Settings sync", "Help"]);
    expect(revealAppleSyncCard(root, true)).toBe(true);
    expect(scrolled).toEqual(["Settings sync"]);
    expect(document.activeElement?.textContent?.trim()).toBe("Settings sync");
  });

  it("only scrolls under the sign-in sheet, and finds the purchased heading", () => {
    const { root, scrolled } = screen(["Still Pro and sync"]);
    expect(revealAppleSyncCard(root, false)).toBe(true);
    expect(scrolled).toEqual(["Still Pro and sync"]);
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves the screen alone when no sync card is rendered", () => {
    const { root, scrolled } = screen(["Still Pro", "Synchronise later", "Help"]);
    expect(revealAppleSyncCard(root, true)).toBe(false);
    expect(scrolled).toEqual([]);
  });
});
