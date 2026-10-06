// End to end on the real settings page: App → controller → page analytics → the extension host's
// background → the account-wide service → a scripted analytics-erasure server (U5-W3 packet B).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import App from "../App.svelte";
import { createStoredConsent, readAnalyticsPermission } from "../../analytics/consent.js";
import {
  createAccountErasureService,
  createErasureService,
  ERASURE_LEDGER_KEY,
  type AccountErasureRequest,
} from "../../analytics/erasure.js";
import {
  ANALYTICS_MESSAGE_KIND,
  createExtensionAnalyticsHost,
  createPageAnalytics,
} from "../../analytics/extension-host.js";
import { TEST_PERMISSION, TEST_PRIVACY, TEST_SUBJECTS } from "../../analytics/__tests__/privacy-fixture.js";
import { browser, capture, flush } from "./committed-popup-host.fixtures.js";

beforeAll(async () => {
  await import("../v3/ExtensionSettings.svelte");
});

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LABEL = "Delete shared data on all devices";
const TITLE = "Delete shared data from all your devices?";

function memory() {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (k: string) => structuredClone(data[k]),
    set: async (k: string, v: unknown) => void (data[k] = structuredClone(v)),
  };
}

async function analytics(options: { subjects: boolean; reply: unknown }) {
  const store = memory();
  const authority = memory();
  const consent = createStoredConsent(authority, false);
  await consent.grant(TEST_PERMISSION.version);
  const sent: AccountErasureRequest[] = [];
  const server = { reply: options.reply };
  const host = createExtensionAnalyticsHost({
    ...TEST_PRIVACY,
    config: { key: "test", host: "https://us.i.posthog.com" },
    surface: "chrome",
    appVersion: "3.0.0",
    local: store,
    identity: async () => ({
      installId: "11111111-1111-4111-8111-111111111111",
      anchorId: "22222222-2222-4222-8222-222222222222",
      created: false,
      returning: false,
    }),
    consent: () => consent.get(),
    permission: async () => readAnalyticsPermission(await consent.read()),
    commitPermission: async (enabled) => (enabled ? consent.grant(TEST_PERMISSION.version) : consent.set(false)),
    noticeApplies: false,
    isTrustedPage: () => true,
    fetch: vi.fn(async () => new Response("{}")) as unknown as typeof fetch,
    erasure: createErasureService({ store, transport: async () => ({ state: "requested" }) }),
    ...(options.subjects ? { subjects: TEST_SUBJECTS } : {}),
    accountErasure: createAccountErasureService({
      store,
      transport: async (body) => {
        sent.push(body);
        if (server.reply instanceof Error) throw server.reply;
        return server.reply;
      },
    }),
  });
  const page = createPageAnalytics({
    send: (message) =>
      new Promise((resolve) => {
        if (!host.listener({ kind: ANALYTICS_MESSAGE_KIND, ...message }, {}, resolve)) resolve(undefined);
      }),
  });
  return { page, host, sent, server, consent, store };
}

async function options(a: Awaited<ReturnType<typeof analytics>>) {
  await browser();
  const state = capture({ analytics: a.page });
  await flush();
  state.controller.userId = ACCOUNT;
  state.controller.accountEmail = "person@fixture.test";
  const view = render(App, {
    controller: state.controller,
    committedPopupBinding: state.binding,
    settingsPresentation: {
      browser: "Chrome" as const,
      loadSettings: () => import("../v3/ExtensionSettings.svelte"),
      help: { onGuide: vi.fn(), onSupport: vi.fn(), onPrivacy: vi.fn() },
    },
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy());
  return { ...view, state };
}

describe("the settings page's account-wide deletion, wired end to end", () => {
  it("dormancy: hidden while per-device identities are not wired", async () => {
    const a = await analytics({ subjects: false, reply: { state: "requested" } });
    const view = await options(a);
    await flush();
    expect(screen.queryByRole("button", { name: LABEL })).toBeNull();
    expect(a.sent).toEqual([]);
    view.unmount();
    a.host.stop();
  });

  it("confirm → the local stop and the request; the progress line; no device erasure", async () => {
    const a = await analytics({ subjects: true, reply: { state: "requested" } });
    const view = await options(a);
    await fireEvent.click(await screen.findByRole("button", { name: LABEL }));
    await fireEvent.click(within(screen.getByRole("dialog", { name: TITLE })).getByRole("button", { name: "Delete shared data" }));
    await screen.findByText("Deletion requested. Your shared data hasn't been deleted yet.");
    expect(a.sent).toEqual([{ action: "account" }]);
    expect(await a.consent.get()).toBe(false);
    expect(a.store.data[ERASURE_LEDGER_KEY]).toBeUndefined();
    expect(screen.queryByRole("button", { name: LABEL })).toBeNull();
    view.unmount();
    a.host.stop();
  });

  it("failure → the approved failure line; Try again → requested", async () => {
    const a = await analytics({ subjects: true, reply: new Error("offline") });
    const view = await options(a);
    await fireEvent.click(await screen.findByRole("button", { name: LABEL }));
    await fireEvent.click(within(screen.getByRole("dialog", { name: TITLE })).getByRole("button", { name: "Delete shared data" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't send your deletion request. Sharing stays off on this device.");
    expect(await a.consent.get()).toBe(false);
    a.server.reply = { state: "requested" };
    await fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByText("Deletion requested. Your shared data hasn't been deleted yet.");
    expect(a.sent).toEqual([{ action: "account" }, { action: "account" }]);
    view.unmount();
    a.host.stop();
  });

  it("cancel sends nothing and stops nothing", async () => {
    const a = await analytics({ subjects: true, reply: { state: "requested" } });
    const view = await options(a);
    await fireEvent.click(await screen.findByRole("button", { name: LABEL }));
    await fireEvent.click(within(screen.getByRole("dialog", { name: TITLE })).getByRole("button", { name: "Cancel" }));
    await flush();
    expect(a.sent).toEqual([]);
    expect(await a.consent.get()).toBe(true);
    view.unmount();
    a.host.stop();
  });
});
