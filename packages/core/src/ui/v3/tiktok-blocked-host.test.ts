import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import { tick } from "svelte";
import TikTokBlocked from "./TikTokBlocked.svelte";
import {
  createTikTokBlockedHost,
  tikTokBlockedPresentation,
  type TikTokBlockedHostActions,
  type TikTokBlockedHostPhase,
} from "./tiktok-blocked-host.js";
import {
  tikTokOpenFailed,
  tikTokPortReady,
  tikTokReloadConfirmed,
  tikTokSupported,
  type TikTokBlockedPresentation,
} from "./tiktok-blocked-presentation.js";
import { TIKTOK_ROUTE } from "../../content/tiktok-blocked-route.js";

afterEach(() => {
  vi.useRealTimers();
});

const identity = { request: "request-1-fixture", tab: "7", document: "document-1" };
const noop: TikTokBlockedHostActions = {
  requestConfirmation: vi.fn(),
  confirmOpen: vi.fn(),
  cancel: vi.fn(),
  settings: vi.fn(),
  reload: vi.fn(),
};
const map = (phase: TikTokBlockedHostPhase, observation = 1) =>
  tikTokBlockedPresentation({ phase, observation, identity }, noop);
const ready = (p: TikTokBlockedPresentation) =>
  (["requestConfirmation", "confirmOpen", "cancel", "settings", "reload"] as const).filter((port) =>
    tikTokPortReady(p, p[port]),
  );

describe("TikTok blocked page presentation mapping", () => {
  it.each([
    ["loading", "blocked", false, []],
    ["blocked", "blocked", true, ["requestConfirmation", "settings"]],
    ["confirmation", "confirmation", true, ["confirmOpen", "cancel"]],
    ["pending", "pending", true, ["settings"]],
    ["granted", "reload", true, ["settings", "reload"]],
    ["unavailable", "blocked", false, ["settings"]],
  ] as const)("%s maps to screen state %s with only its honest ports ready", (phase, state, supported, ports) => {
    const p = map(phase);
    expect(p.state).toBe(state);
    expect(tikTokSupported(p)).toBe(supported);
    expect(ready(p)).toEqual(ports);
    expect(tikTokReloadConfirmed(p)).toBe(phase === "granted");
    expect(p.host).toBe("browser");
    expect(JSON.stringify(p)).not.toMatch(/https?:/);
  });

  it("every republish is a new observation so the screen's fences reopen", () => {
    expect(map("blocked", 1).observation).not.toBe(map("blocked", 2).observation);
  });
});

function harness(replies: Partial<Record<string, unknown>> = {}) {
  const sent: string[] = [];
  const answers = new Map<string, unknown>(Object.entries(replies));
  const send = vi.fn(async ({ kind }: { kind: string }) => {
    sent.push(kind);
    const answer = answers.get(kind);
    return typeof answer === "function" ? (answer as () => unknown)() : answer;
  });
  const openSettings = vi.fn();
  const navigate = vi.fn();
  const host = createTikTokBlockedHost({ send, openSettings, navigate, request: "request-1-fixture", document: "document-1" });
  const published: TikTokBlockedPresentation[] = [];
  host.subscribe((p) => published.push(p));
  return { host, sent, answers, send, openSettings, navigate, published };
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("TikTok blocked page host state machine", () => {
  it("asks the background before showing anything and binds the actual tab", async () => {
    const h = harness({ [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 } });
    expect(h.host.current().verified).toBe(false);
    await h.host.start();
    expect(h.host.state().phase).toBe("blocked");
    expect(h.host.current().identity).toEqual(identity);
  });

  it.each([
    [{ status: "granted", tab: 7 }, "granted"],
    [{ status: "unavailable", tab: 7 }, "unavailable"],
    [undefined, "unavailable"],
  ] as const)("start reply %j shows %s", async (reply, phase) => {
    const h = harness({ [TIKTOK_ROUTE.screen]: reply });
    await h.host.start();
    expect(h.host.state().phase).toBe(phase);
  });

  it("request -> confirmation -> confirm -> granted -> reload replaces the page with the returned destination", async () => {
    const h = harness({
      [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 },
      [TIKTOK_ROUTE.request]: { status: "confirming" },
      [TIKTOK_ROUTE.confirm]: { status: "granted" },
      [TIKTOK_ROUTE.open]: { status: "open", url: "https://www.tiktok.com/@fixture" },
    });
    await h.host.start();
    h.host.actions.requestConfirmation();
    expect(h.host.state().phase).toBe("pending");
    await settle();
    expect(h.host.state().phase).toBe("confirmation");
    h.host.actions.confirmOpen();
    // The caller arbitrates: a cancel after the confirm in the same observation is ignored.
    h.host.actions.cancel();
    await settle();
    expect(h.host.state().phase).toBe("granted");
    h.host.actions.reload();
    await settle();
    expect(h.navigate).toHaveBeenCalledWith("https://www.tiktok.com/@fixture");
    expect(h.sent).toEqual([TIKTOK_ROUTE.screen, TIKTOK_ROUTE.request, TIKTOK_ROUTE.confirm, TIKTOK_ROUTE.open]);
  });

  it.each([
    ["failed request", TIKTOK_ROUTE.request, { status: "failed" }],
    ["failed confirm", TIKTOK_ROUTE.confirm, { status: "failed" }],
    ["malformed confirm", TIKTOK_ROUTE.confirm, { status: "granted?" }],
  ])("%s is truthful: back to blocked under a fresh observation", async (_name, kind, reply) => {
    const h = harness({
      [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 },
      [TIKTOK_ROUTE.request]: { status: "confirming" },
      [TIKTOK_ROUTE.confirm]: { status: "granted" },
      [kind]: reply,
    });
    await h.host.start();
    const first = h.host.current().observation;
    h.host.actions.requestConfirmation();
    await settle();
    if (h.host.state().phase === "confirmation") {
      h.host.actions.confirmOpen();
      await settle();
    }
    expect(h.host.state().phase).toBe("blocked");
    expect(h.host.current().observation).not.toBe(first);
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("cancel closes at once and tells the background; settings opens settings with a fresh observation", async () => {
    const h = harness({ [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 }, [TIKTOK_ROUTE.request]: { status: "confirming" } });
    await h.host.start();
    h.host.actions.requestConfirmation();
    await settle();
    h.host.actions.cancel();
    expect(h.host.state().phase).toBe("blocked");
    await settle();
    expect(h.sent.at(-1)).toBe(TIKTOK_ROUTE.cancel);
    const before = h.host.current().observation;
    h.host.actions.settings();
    await settle();
    expect(h.openSettings).toHaveBeenCalledTimes(1);
    expect(h.host.current().observation).not.toBe(before);
    expect(h.host.state().phase).toBe("blocked");
  });

  it("a reload without a valid destination never navigates", async () => {
    for (const reply of [{ status: "failed" }, { status: "open" }, { status: "open", url: 7 }]) {
      const h = harness({ [TIKTOK_ROUTE.screen]: { status: "granted", tab: 7 }, [TIKTOK_ROUTE.open]: reply });
      await h.host.start();
      h.host.actions.reload();
      await settle();
      expect(h.navigate).not.toHaveBeenCalled();
      expect(h.host.state().phase).toBe("blocked");
    }
  });

  it("every background wait is bounded: a silent background ends as blocked, never stuck pending", async () => {
    vi.useFakeTimers();
    const h = harness({ [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 } });
    await h.host.start();
    h.answers.set(TIKTOK_ROUTE.request, () => new Promise(() => {}));
    h.host.actions.requestConfirmation();
    expect(h.host.state().phase).toBe("pending");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.host.state().phase).toBe("blocked");
  });

  it("closes the dialog when the background no longer holds the confirmation", async () => {
    vi.useFakeTimers();
    const h = harness({
      [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 },
      [TIKTOK_ROUTE.request]: { status: "confirming" },
      [TIKTOK_ROUTE.confirming]: { status: "confirming" },
    });
    await h.host.start();
    h.host.actions.requestConfirmation();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.host.state().phase).toBe("confirmation");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.host.state().phase).toBe("confirmation");
    h.answers.set(TIKTOK_ROUTE.confirming, { status: "idle" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.host.state().phase).toBe("blocked");
    h.host.stop();
  });
});

describe("TikTok host lifetime and confirmation reply fencing", () => {
  it("does not navigate when a reopen answer arrives after the host stops", async () => {
    let answer!: (reply: unknown) => void;
    const h = harness({
      [TIKTOK_ROUTE.screen]: { status: "granted", tab: 7 },
      [TIKTOK_ROUTE.open]: () => new Promise((resolve) => { answer = resolve; }),
    });
    await h.host.start();
    h.host.actions.reload();
    await settle();
    h.host.stop();
    answer({ status: "open", url: "https://www.tiktok.com/@fixture" });
    await settle();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("a lost document connection publishes unavailable before stopping retained actions", async () => {
    const h = harness({ [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 } });
    await h.host.start();
    h.host.stop(true);
    expect(h.host.state().phase).toBe("unavailable");
    expect(h.published.at(-1)?.capability?.status).toBe("unavailable");
    h.host.actions.requestConfirmation();
    await settle();
    expect(h.sent).toEqual([TIKTOK_ROUTE.screen]);
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("settings republishing does not discard a current reopen answer", async () => {
    let answer!: (reply: unknown) => void;
    const h = harness({
      [TIKTOK_ROUTE.screen]: { status: "granted", tab: 7 },
      [TIKTOK_ROUTE.open]: () => new Promise((resolve) => { answer = resolve; }),
    });
    await h.host.start();
    h.host.actions.reload();
    await settle();
    h.host.actions.settings();
    await settle();
    answer({ status: "open", url: "https://www.tiktok.com/@fixture" });
    await settle();
    expect(h.openSettings).toHaveBeenCalledOnce();
    expect(h.navigate).toHaveBeenCalledWith("https://www.tiktok.com/@fixture");
  });

  it("stopped hosts cannot dispatch retained actions or queued settings openings", async () => {
    const h = harness({ [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 } });
    await h.host.start();
    h.host.actions.settings();
    const sent = h.sent.length;
    h.host.stop();
    h.host.actions.requestConfirmation();
    h.host.actions.confirmOpen();
    h.host.actions.cancel();
    h.host.actions.reload();
    h.host.actions.settings();
    await h.host.start();
    await settle();
    expect(h.sent).toHaveLength(sent);
    expect(h.openSettings).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("does not let an earlier dialog heartbeat close a later confirmation", async () => {
    vi.useFakeTimers();
    let answer!: (reply: unknown) => void;
    const h = harness({
      [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 },
      [TIKTOK_ROUTE.request]: { status: "confirming" },
      [TIKTOK_ROUTE.cancel]: { status: "cancelled" },
      [TIKTOK_ROUTE.confirming]: () => new Promise((resolve) => { answer = resolve; }),
    });
    await h.host.start();
    h.host.actions.requestConfirmation();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.host.state().phase).toBe("confirmation");
    h.host.actions.cancel();
    await settle();
    h.host.actions.requestConfirmation();
    await settle();
    expect(h.host.state().phase).toBe("confirmation");
    const current = h.host.current().observation;
    answer({ status: "idle" });
    await settle();
    expect(h.host.state().phase).toBe("confirmation");
    expect(h.host.current().observation).toBe(current);
    expect(tikTokOpenFailed(h.host.current())).toBe(false);
    h.host.stop();
  });
});

describe("TikTokBlocked rendered from the host", () => {
  it("drives the real screen: open, confirm, reload", async () => {
    const h = harness({
      [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 },
      [TIKTOK_ROUTE.request]: { status: "confirming" },
      [TIKTOK_ROUTE.confirm]: { status: "granted" },
      [TIKTOK_ROUTE.open]: { status: "open", url: "https://www.tiktok.com/@fixture" },
    });
    await h.host.start();
    const view = render(TikTokBlocked, { presentation: h.host.current() });
    h.host.subscribe((presentation) => void view.rerender({ presentation }));
    await fireEvent.click(screen.getByRole("button", { name: "Open TikTok this time" }));
    await settle();
    await tick();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Open TikTok in this tab?");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Open TikTok this time" }));
    await settle();
    await tick();
    expect(screen.getByText("Reload this page to open TikTok.")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
    await settle();
    expect(h.navigate).toHaveBeenCalledWith("https://www.tiktok.com/@fixture");
    expect(h.sent).toEqual([TIKTOK_ROUTE.screen, TIKTOK_ROUTE.request, TIKTOK_ROUTE.confirm, TIKTOK_ROUTE.open]);
  });

  it("an unavailable page keeps TikTok closed with opening disabled but settings reachable", async () => {
    const h = harness({ [TIKTOK_ROUTE.screen]: { status: "unavailable", tab: 7 } });
    await h.host.start();
    render(TikTokBlocked, { presentation: h.host.current() });
    expect(screen.getByRole("heading", { name: "TikTok stays closed." })).toBeInTheDocument();
    const open = screen.getByRole("button", { name: "Open TikTok this time" });
    expect(open).toHaveAttribute("aria-disabled", "true");
    await fireEvent.click(open);
    await fireEvent.click(screen.getByRole("button", { name: "Change this in Still settings" }));
    await settle();
    expect(h.sent).toEqual([TIKTOK_ROUTE.screen]);
    expect(h.openSettings).toHaveBeenCalledTimes(1);
  });
});

// Owner decision 34: a failed "Open TikTok this time" shows exactly "Couldn't open TikTok." with a
// Try again action. Try again is the ordinary fenced request: it can only reopen the confirmation.
const FAILED_LINE = "Couldn't open TikTok.";

async function failedHarness(kind: string, reply: unknown) {
  const h = harness({
    [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 },
    [TIKTOK_ROUTE.request]: { status: "confirming" },
    [TIKTOK_ROUTE.confirm]: { status: "granted" },
    [kind]: reply,
  });
  await h.host.start();
  h.host.actions.requestConfirmation();
  await settle();
  if (h.host.state().phase === "confirmation") {
    h.host.actions.confirmOpen();
    await settle();
  }
  return h;
}

describe("decision 34: the TikTok open failure line", () => {
  it.each([
    ["a failed request", TIKTOK_ROUTE.request, { status: "failed" }],
    ["an unexpected request reply", TIKTOK_ROUTE.request, { status: "cancelled" }],
    ["a request that throws", TIKTOK_ROUTE.request, () => Promise.reject(new Error("worker gone"))],
    ["a failed confirm", TIKTOK_ROUTE.confirm, { status: "failed" }],
    ["a malformed confirm", TIKTOK_ROUTE.confirm, { status: "granted?" }],
    ["a confirm that throws", TIKTOK_ROUTE.confirm, () => Promise.reject(new Error("worker gone"))],
  ])("%s returns to blocked with the failure line and grants nothing", async (_name, kind, reply) => {
    const h = await failedHarness(kind, reply);
    const p = h.host.current();
    expect(p.state).toBe("blocked");
    expect(tikTokOpenFailed(p)).toBe(true);
    expect(tikTokPortReady(p, p.requestConfirmation)).toBe(true);
    expect(tikTokReloadConfirmed(p)).toBe(false);
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it.each([
    ["request", TIKTOK_ROUTE.request],
    ["confirm", TIKTOK_ROUTE.confirm],
  ])("a %s the background never answers ends in the failure line, never stuck pending", async (_name, kind) => {
    vi.useFakeTimers();
    const h = harness({
      [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 },
      [TIKTOK_ROUTE.request]: { status: "confirming" },
      [kind]: () => new Promise(() => {}),
    });
    await h.host.start();
    h.host.actions.requestConfirmation();
    await vi.advanceTimersByTimeAsync(kind === TIKTOK_ROUTE.request ? 15_000 : 0);
    if (kind === TIKTOK_ROUTE.confirm) {
      expect(h.host.state().phase).toBe("confirmation");
      h.host.actions.confirmOpen();
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(h.host.state().phase).toBe("blocked");
    expect(tikTokOpenFailed(h.host.current())).toBe(true);
    h.host.stop();
  });

  it("a reopen without a destination and a confirmation the background let go both show the line", async () => {
    const reopen = harness({ [TIKTOK_ROUTE.screen]: { status: "granted", tab: 7 }, [TIKTOK_ROUTE.open]: { status: "failed" } });
    await reopen.host.start();
    reopen.host.actions.reload();
    await settle();
    expect(tikTokOpenFailed(reopen.host.current())).toBe(true);
    expect(reopen.navigate).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const dropped = harness({
      [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 },
      [TIKTOK_ROUTE.request]: { status: "confirming" },
      [TIKTOK_ROUTE.confirming]: { status: "idle" },
    });
    await dropped.host.start();
    dropped.host.actions.requestConfirmation();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dropped.host.state().phase).toBe("blocked");
    expect(tikTokOpenFailed(dropped.host.current())).toBe(true);
    dropped.host.stop();
  });

  it("is absent on a fresh page and after Keep it closed; settings keeps it; a new attempt clears it", async () => {
    const h = harness({ [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 }, [TIKTOK_ROUTE.request]: { status: "confirming" } });
    await h.host.start();
    expect(tikTokOpenFailed(h.host.current())).toBe(false);
    h.host.actions.requestConfirmation();
    await settle();
    h.host.actions.cancel();
    expect(tikTokOpenFailed(h.host.current())).toBe(false);
    for (const phase of ["loading", "confirmation", "pending", "granted", "unavailable"] as const)
      expect(tikTokOpenFailed(tikTokBlockedPresentation({ phase, observation: 1, identity, failed: true }, noop)), phase).toBe(false);

    h.answers.set(TIKTOK_ROUTE.request, { status: "failed" });
    h.host.actions.requestConfirmation();
    await settle();
    expect(tikTokOpenFailed(h.host.current())).toBe(true);
    h.host.actions.settings();
    expect(tikTokOpenFailed(h.host.current())).toBe(true);
    h.answers.set(TIKTOK_ROUTE.request, { status: "confirming" });
    h.host.actions.requestConfirmation();
    expect(h.host.state().phase).toBe("pending");
    expect(tikTokOpenFailed(h.host.current())).toBe(false);
  });

  it("Try again only asks again: it reopens the confirmation and grants nothing until the person confirms", async () => {
    const h = await failedHarness(TIKTOK_ROUTE.confirm, { status: "failed" });
    h.answers.set(TIKTOK_ROUTE.confirm, { status: "granted" });
    h.answers.set(TIKTOK_ROUTE.open, { status: "open", url: "https://www.tiktok.com/@fixture" });
    const view = render(TikTokBlocked, { presentation: h.host.current() });
    h.host.subscribe((presentation) => void view.rerender({ presentation }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(FAILED_LINE);
    expect(alert).toHaveAttribute("data-tone", "failed");
    const before = h.sent.length;
    const retry = within(alert).getByRole("button", { name: "Try again" });
    // Single flight: a double activation, plus the page's own open button, sends one request.
    await fireEvent.click(retry);
    await fireEvent.click(retry);
    await fireEvent.click(document.querySelector<HTMLElement>(".blocked-actions button.secondary")!);
    await settle();
    await tick();
    expect(h.sent.slice(before)).toEqual([TIKTOK_ROUTE.request]);
    expect(h.host.state().phase).toBe("confirmation");
    expect(screen.queryByText(FAILED_LINE)).toBeNull();
    expect(screen.queryByText("Reload this page to open TikTok.")).toBeNull();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Open TikTok in this tab?");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Open TikTok this time" }));
    await settle();
    await tick();
    expect(h.sent.slice(before)).toEqual([TIKTOK_ROUTE.request, TIKTOK_ROUTE.confirm]);
    expect(screen.getByText("Reload this page to open TikTok.")).toBeInTheDocument();
    view.unmount();
  });

  it("renders no failure line on the ordinary blocked page", async () => {
    const h = harness({ [TIKTOK_ROUTE.screen]: { status: "blocked", tab: 7 } });
    await h.host.start();
    render(TikTokBlocked, { presentation: h.host.current() });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(FAILED_LINE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
