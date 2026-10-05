import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { SettingsCache } from "../../storage/cache.js";
import { ChromeStorageAdapter } from "../../storage/chrome-adapter.js";
import { createSettingsIntentRouter } from "../../storage/settings-messages.js";
import type { StoredSettingsRecord } from "../../storage/adapter.js";
import { UiController } from "../controller.svelte.js";
import App from "../App.svelte";
import { createExtensionUiController } from "../extension-setup.js";
import type { LegacyPopupAuthority } from "../v3/legacy-popup-view-binding.svelte.js";
const KEY = "still:settings";
const ORIGIN = "chrome-extension://still/";
function saved(on = false, updatedAt = 100) {
  return {
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      schemaVersion: 1,
      globalOn: on,
      services: { ...DEFAULT_SETTINGS.services, youtube: false, tiktok: false },
      updatedAt,
      opaqueChoice: { retained: false },
    },
    syncMetadata: null,
    syncEpoch: 0,
    opaqueRoot: { retained: true },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Synthetic Chrome storage/transport, maintained production consumer, authority and intent router.
function browser(initial: unknown, present = true) {
  let raw: unknown = structuredClone(initial);
  let exists = present;
  const listeners = new Set<
    (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => void
  >();
  const local = {
    get: vi.fn(async (key: string): Promise<Record<string, unknown>> =>
      key === KEY && exists ? { [KEY]: structuredClone(raw) } : {},
    ),
    set: vi.fn(async (values: Record<string, unknown>) => {
      raw = structuredClone(values[KEY]);
      exists = true;
    }),
  };
  let delivery: (reply: unknown) => Promise<unknown> = async (reply) => reply;
  const sendMessage = vi.fn<(message: unknown) => Promise<unknown>>();
  const removeListener = vi.fn(
    (listener: Parameters<typeof listeners.add>[0]) =>
      listeners.delete(listener),
  );
  vi.stubGlobal("chrome", {
    storage: {
      local,
      onChanged: {
        addListener: (listener: Parameters<typeof listeners.add>[0]) =>
          listeners.add(listener),
        removeListener,
      },
    },
    runtime: { getURL: () => ORIGIN, sendMessage },
  });
  const authority = new ChromeStorageAdapter({ authority: true });
  const route = createSettingsIntentRouter(
    authority.commitIntent.bind(authority),
    "still",
    ORIGIN,
  );
  sendMessage.mockImplementation(
    (message) =>
      new Promise((resolve, reject) => {
        if (
          !route(
            structuredClone(message),
            { id: "still", url: `${ORIGIN}popup.html` },
            (reply) => {
              void delivery(structuredClone(reply)).then(resolve, reject);
            },
          )
        )
          reject(new Error("Synthetic sender was not admitted"));
      }),
  );
  const consumer = new ChromeStorageAdapter();
  const cache = new SettingsCache(consumer, { now: () => 200 });
  cache.watch();
  const controller = new UiController({ cache, host: { canPurchase: false } });
  return {
    cache,
    controller,
    removeListener,
    consumer,
    authority,
    local,
    sendMessage,
    delayReply(next: typeof delivery) {
      delivery = next;
    },
    raw: () => structuredClone(raw),
    put(value: unknown, keyPresent = true) {
      raw = structuredClone(value);
      exists = keyPresent;
    },
    emit(record: StoredSettingsRecord) {
      raw = structuredClone(record);
      exists = true;
      for (const listener of [...listeners])
        listener({ [KEY]: { newValue: structuredClone(record) } }, "local");
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function view(h: ReturnType<typeof browser>, report = vi.fn()) {
  const mounted = render(App, {
    props: {
      controller: h.controller,
      legacyPopupAuthority: h.cache,
      onCommittedPopupToggle: report,
    },
  });
  return { ...mounted, report };
}
const globalSwitch = () => screen.getByRole("switch", { name: "Still on/off" });

describe("actual App legacy authority", () => {
  it("keeps pending initial saved read distinct from packaged defaults", async () => {
    const h = browser(saved(false));
    const gate = deferred<Record<string, unknown>>();
    h.local.get.mockImplementationOnce(() => gate.promise);
    const load = h.cache.hydrate();
    view(h);
    expect(screen.queryByRole("switch", { name: "Still on/off" })).toBeNull();
    expect(
      document
        .querySelector(".still-ui")
        ?.getAttribute("data-settings-receipt"),
    ).toBe("loading");
    expect(h.local.set).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    gate.resolve({ [KEY]: saved(false) });
    await load;
    await waitFor(() =>
      expect(globalSwitch().getAttribute("aria-checked")).toBe("false"),
    );
  });
  it("uses the actual saved schema1 zero-clock Off record without writes or events", async () => {
    const h = browser(saved(false, 0));
    await h.cache.hydrate();
    const v = view(h);
    await tick();
    expect(globalSwitch().getAttribute("aria-checked")).toBe("false");
    expect(
      document
        .querySelector(".still-ui")
        ?.getAttribute("data-settings-receipt"),
    ).toBe("ready");
    expect(h.raw()).toEqual(saved(false, 0));
    expect(h.local.set).not.toHaveBeenCalled();
    expect(v.report).not.toHaveBeenCalled();
  });
  it.each([
    null,
    "corrupt",
    { ...saved(), settings: { ...saved().settings, schemaVersion: 3 } },
  ])(
    "holds unreadable keyed storage %j and offers an explicit read-only retry",
    async (raw) => {
      const h = browser(raw);
      await h.cache.hydrate().catch(() => {});
      const v = view(h);
      await tick();
      expect(screen.getByText("Settings are unavailable.")).toBeTruthy();
      expect(screen.queryByRole("switch", { name: "Still on/off" })).toBeNull();
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
      expect(h.raw()).toEqual(raw);
      expect(h.local.set).not.toHaveBeenCalled();
      expect(v.report).not.toHaveBeenCalled();
    },
  );
  it("retains saved Off choices through failure, singleflight retry and current recovery without replay", async () => {
    const h = browser(saved(false));
    await h.cache.hydrate();
    const v = view(h);
    await tick();
    h.local.get.mockRejectedValueOnce(new Error("read down"));
    await h.cache.rereadLegacyAuthority();
    await tick();
    expect(globalSwitch().getAttribute("aria-checked")).toBe("false");
    expect((globalSwitch() as HTMLButtonElement).disabled).toBe(true);
    const reads = h.local.get.mock.calls.length;
    const gate = deferred<Record<string, unknown>>();
    h.local.get.mockImplementationOnce(() => gate.promise);
    const retry = screen.getByRole("button", { name: "Try again" });
    await fireEvent.click(retry);
    await fireEvent.click(retry);
    await flush();
    expect(h.local.get.mock.calls.length).toBe(reads + 1);
    expect(h.local.set).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    gate.resolve({ [KEY]: saved(false) });
    await waitFor(() =>
      expect((globalSwitch() as HTMLButtonElement).disabled).toBe(false),
    );
    expect(v.report).not.toHaveBeenCalled();
    expect(h.local.set).not.toHaveBeenCalled();
  });
  it("keeps actual absence unsaved until a deliberate real write", async () => {
    const h = browser(null, false);
    await h.cache.hydrate();
    const v = view(h);
    await tick();
    expect(
      document
        .querySelector(".still-ui")
        ?.getAttribute("data-settings-receipt"),
    ).toBe("absent");
    expect(h.local.set).not.toHaveBeenCalled();
    await fireEvent.click(globalSwitch());
    await waitFor(() => expect(h.local.set).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(v.report).toHaveBeenCalledExactlyOnceWith({ enabled: false }),
    );
    expect(
      document
        .querySelector(".still-ui")
        ?.getAttribute("data-settings-receipt"),
    ).toBe("ready");
    expect((h.raw() as StoredSettingsRecord).settings.globalOn).toBe(false);
  });
  it("reports only the true receipt for overlapping same-target true then no-op commands", async () => {
    const h = browser(saved(false));
    await h.cache.hydrate();
    const v = view(h);
    await tick();
    const gate = deferred<void>();
    h.delayReply(async (reply) => {
      await gate.promise;
      return reply;
    });
    await fireEvent.click(globalSwitch());
    await fireEvent.click(globalSwitch());
    await flush();
    expect(h.local.set).toHaveBeenCalledTimes(1);
    expect(v.report).not.toHaveBeenCalled();
    gate.resolve();
    await waitFor(() =>
      expect(v.report).toHaveBeenCalledExactlyOnceWith({ enabled: true }),
    );
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
  });
  it("reports both distinct true commits after the later saved projection wins", async () => {
    const record = saved(true);
    record.settings.services.instagram = false;
    record.settings.services.facebook = false;
    const h = browser(record);
    await h.cache.hydrate();
    const v = view(h);
    await tick();
    const gate = deferred<void>();
    h.delayReply(async (reply) => {
      await gate.promise;
      return reply;
    });
    await fireEvent.click(
      screen.getByRole("switch", { name: "Still on Instagram Reels" }),
    );
    await fireEvent.click(
      screen.getByRole("switch", { name: "Still on Facebook Reels" }),
    );
    await flush();
    gate.resolve();
    await waitFor(() => expect(v.report).toHaveBeenCalledTimes(2));
    expect(v.report.mock.calls).toEqual([
      [{ service: "instagram", enabled: true }],
      [{ service: "facebook", enabled: true }],
    ]);
  });
  it("holds a real write failure until explicit pure retry and a new gesture", async () => {
    const h = browser(saved(false));
    await h.cache.hydrate();
    const v = view(h);
    await tick();
    h.local.set.mockRejectedValueOnce(new Error("write down"));
    await fireEvent.click(globalSwitch());
    await waitFor(() =>
      expect(screen.getByText("Settings are unavailable.")).toBeTruthy(),
    );
    expect(v.report).not.toHaveBeenCalled();
    expect((h.raw() as StoredSettingsRecord).settings.globalOn).toBe(false);
    const commands = h.sendMessage.mock.calls.length;
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect((globalSwitch() as HTMLButtonElement).disabled).toBe(false),
    );
    expect(h.sendMessage.mock.calls.length).toBe(commands);
    expect(v.report).not.toHaveBeenCalled();
    await fireEvent.click(globalSwitch());
    await waitFor(() =>
      expect(v.report).toHaveBeenCalledExactlyOnceWith({ enabled: true }),
    );
  });
  it.each(["account-ABA", "controller", "authority", "unmount"])(
    "suppresses a late true receipt after %s while preserving the admitted write",
    async (change) => {
      const h = browser(saved(false));
      await h.cache.hydrate();
      h.controller.userId = "A";
      const v = view(h);
      await tick();
      const gate = deferred<void>();
      h.delayReply(async (reply) => {
        await gate.promise;
        return reply;
      });
      await fireEvent.click(globalSwitch());
      await flush();
      expect(h.local.set).toHaveBeenCalledTimes(1);
      if (change === "account-ABA") {
        h.controller.accountRevision += 1;
        h.controller.userId = "B";
        h.controller.accountRevision += 1;
        h.controller.userId = "A";
      } else if (change === "unmount") v.unmount();
      else {
        const other = browser(saved(false));
        await other.cache.hydrate();
        await v.rerender({
          controller: change === "controller" ? other.controller : h.controller,
          legacyPopupAuthority: change === "authority" ? other.cache : h.cache,
          onCommittedPopupToggle: v.report,
        });
      }
      await tick();
      gate.resolve();
      await flush();
      await tick();
      expect(v.report).not.toHaveBeenCalled();
      expect((h.raw() as StoredSettingsRecord).settings.globalOn).toBe(true);
    },
  );
});

describe("factory legacy attachment and view recovery lifetimes", () => {
  it("hands the exact single factory cache to the narrow hook and catches its failed initial hydrate without another read", async () => {
    const h = browser(saved(false));
    h.local.get.mockRejectedValueOnce(new Error("initial read down"));
    const hydrate = vi.spyOn(SettingsCache.prototype, "hydrate");
    const watch = vi.spyOn(SettingsCache.prototype, "watch");
    let authority: LegacyPopupAuthority | undefined;
    const controller = createExtensionUiController(undefined, {
      onLegacyPopupAuthority: (port) => {
        authority = port;
      },
    });
    render(App, { props: { controller, legacyPopupAuthority: authority } });
    await waitFor(() =>
      expect(screen.getByText("Settings are unavailable.")).toBeTruthy(),
    );
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(authority).toBe(hydrate.mock.contexts[0]);
    expect(authority).toBe(watch.mock.contexts[0]);
    expect(h.local.set).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(
      h.local.get.mock.calls.filter((c) => c[0] === "still:settings"),
    ).toHaveLength(1);
  });
  it("rethrows a rejected hook without creating a view subscription or stopping the factory watcher", async () => {
    const h = browser(saved(false));
    const subscribe = vi.spyOn(SettingsCache.prototype, "subscribeLegacyRead");
    const watch = vi.spyOn(SettingsCache.prototype, "watch");
    const error = new Error("rejected hook");
    expect(() =>
      createExtensionUiController(undefined, {
        onLegacyPopupAuthority: () => {
          throw error;
        },
      }),
    ).toThrow(error);
    await flush();
    expect(subscribe).not.toHaveBeenCalled();
    expect(watch).toHaveBeenCalledTimes(1);
    expect(h.removeListener).not.toHaveBeenCalled();
    expect(h.local.set).not.toHaveBeenCalled();
  });
  it("detaches only the view's actual receipt subscription", async () => {
    const h = browser(saved(false));
    await h.cache.hydrate();
    const original = h.cache.subscribeLegacyRead.bind(h.cache);
    const unsubscribe = vi.fn();
    vi.spyOn(h.cache, "subscribeLegacyRead").mockImplementation((listener) => {
      const off = original(listener);
      return () => {
        unsubscribe();
        off();
      };
    });
    const v = view(h);
    await tick();
    v.unmount();
    await tick();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.removeListener).not.toHaveBeenCalled();
  });
  it.each(["account-ABA", "controller", "authority", "unmount"])(
    "a late rejected pure retry cannot change a newer accepted view after %s",
    async (change) => {
      const h = browser(saved(false));
      await h.cache.hydrate();
      h.controller.userId = "A";
      const v = view(h);
      await tick();
      h.local.get.mockRejectedValueOnce(new Error("read down"));
      await h.cache.rereadLegacyAuthority();
      await tick();
      const gate = deferred<Record<string, unknown>>();
      h.local.get.mockImplementationOnce(() => gate.promise);
      await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await flush();
      const next = saved(true, 300);
      h.emit(next);
      await tick();
      if (change === "account-ABA") {
        h.controller.accountRevision += 1;
        h.controller.userId = "B";
        h.controller.accountRevision += 1;
        h.controller.userId = "A";
      } else if (change === "unmount") v.unmount();
      else {
        const other = browser(next);
        await other.cache.hydrate();
        await v.rerender({
          controller: change === "controller" ? other.controller : h.controller,
          legacyPopupAuthority: change === "authority" ? other.cache : h.cache,
          onCommittedPopupToggle: v.report,
        });
      }
      await tick();
      gate.reject(new Error("late read rejection"));
      await flush();
      await tick();
      if (change !== "unmount") {
        expect(globalSwitch().getAttribute("aria-checked")).toBe("true");
        expect((globalSwitch() as HTMLButtonElement).disabled).toBe(false);
        expect(screen.queryByText("Settings are unavailable.")).toBeNull();
      }
      expect(v.report).not.toHaveBeenCalled();
      expect(h.local.set).not.toHaveBeenCalled();
    },
  );
  it("does not change the original App route when no legacy authority is supplied", async () => {
    const h = browser(saved(false));
    render(App, { props: { controller: h.controller } });
    expect(globalSwitch().getAttribute("aria-checked")).toBe("true");
    expect(
      document
        .querySelector(".still-ui")
        ?.hasAttribute("data-settings-receipt"),
    ).toBe(false);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
