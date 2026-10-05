import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { fixture } from "../../../../core/src/ui/v3/DesktopPopup.fixtures.js";
import type {
  PopupInvitationPort,
  PopupInvitationReservation,
} from "../../../../core/src/ui/v3/popup-invitation-flow.js";
import { configurePopupInvitationHost } from "../../../lib/invitation-popup-host.js";
import InvitedDesktopPopup from "../InvitedDesktopPopup.svelte";

afterEach(() => {
  cleanup();
  configurePopupInvitationHost(null);
});

const CARD = "Use the same settings in every browser";
const reserved: PopupInvitationReservation = {
  installation: "install-1",
  reservation: { kind: "sync", opening: "opening-1", generation: 2 },
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

function host(port: PopupInvitationPort, userId: string | null = null) {
  const controller = { userId, openSignIn: vi.fn() };
  const h = { controller, port, opening: "opening-1", surface: "chrome" as const, started: false };
  configurePopupInvitationHost(h);
  return h;
}

describe("the invitation wrapper around the V3 popup", () => {
  it("renders the card only after the commit has resolved, never before", async () => {
    const { props } = await fixture();
    const commit = deferred<boolean>();
    let cardAtCommit: boolean | null = null;
    host({
      present: async () => reserved,
      commit: () => { cardAtCommit = screen.queryByRole("region", { name: CARD }) !== null; return commit.promise; },
    });
    render(InvitedDesktopPopup, { props });
    await waitFor(() => expect(cardAtCommit).not.toBeNull());
    expect(cardAtCommit).toBe(false);
    expect(screen.queryByRole("region", { name: CARD })).toBeNull();
    commit.resolve(true);
    expect(await screen.findByRole("region", { name: CARD })).toBeTruthy();
    expect(screen.getByText("Sign in for free settings sync. Optional.")).toBeTruthy();
  });

  it("shows no card when the commit is rejected or nothing is reserved", async () => {
    const { props } = await fixture();
    const commit = vi.fn(async () => false);
    host({ present: async () => reserved, commit });
    render(InvitedDesktopPopup, { props });
    await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByRole("region", { name: CARD })).toBeNull();
    cleanup();
    const none = vi.fn(async () => true);
    host({ present: async () => null, commit: none });
    render(InvitedDesktopPopup, { props });
    await new Promise(r => setTimeout(r, 20));
    expect(none).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: CARD })).toBeNull();
  });

  it("Not now closes the card without opening sign-in", async () => {
    const { props } = await fixture();
    const h = host({ present: async () => reserved, commit: async () => true });
    render(InvitedDesktopPopup, { props });
    const card = await screen.findByRole("region", { name: CARD });
    await fireEvent.click(within(card).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: CARD })).toBeNull());
    expect(h.controller.openSignIn).not.toHaveBeenCalled();
  });

  it("Sign in opens the existing sign-in flow once and closes the card", async () => {
    const { props } = await fixture();
    const h = host({ present: async () => reserved, commit: async () => true });
    render(InvitedDesktopPopup, { props });
    const card = await screen.findByRole("region", { name: CARD });
    await fireEvent.click(within(card).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: CARD })).toBeNull());
    expect(h.controller.openSignIn).toHaveBeenCalledOnce();
  });

  it("shows nothing to someone who is signed in", async () => {
    const { props } = await fixture();
    host({ present: async () => reserved, commit: async () => true }, "user-1");
    render(InvitedDesktopPopup, { props });
    await new Promise(r => setTimeout(r, 30));
    expect(screen.queryByRole("region", { name: CARD })).toBeNull();
  });

  it("makes one attempt per popup page even if the view mounts again", async () => {
    const { props } = await fixture();
    const present = vi.fn(async () => null);
    host({ present, commit: async () => true });
    render(InvitedDesktopPopup, { props });
    await waitFor(() => expect(present).toHaveBeenCalledOnce());
    cleanup();
    render(InvitedDesktopPopup, { props });
    await new Promise(r => setTimeout(r, 20));
    expect(present).toHaveBeenCalledOnce();
  });

  it("is the plain popup when no host is configured", async () => {
    const { props } = await fixture();
    render(InvitedDesktopPopup, { props });
    expect(screen.queryByRole("region", { name: CARD })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });
});
