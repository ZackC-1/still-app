import { afterEach, vi, type Mock } from "vitest";
import {
  cleanup,
  render,
  screen,
  within,
  type RenderResult,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import {
  ChromeStorageAdapter,
  createSettingsIntentRouter,
  type SettingsIntent,
  type StoredSettingsRecord,
} from "../../storage/index.js";
import {
  createExtensionUiController,
  type ExtensionPurchaseDeps,
} from "../extension-setup.js";
import type { createDesktopPopupBinding } from "../v3/desktop-popup-binding.js";
import App from "../App.svelte";
import type { UiAnalytics } from "../controller.svelte.js";

type PurchaseFixture = {
  deps: ExtensionPurchaseDeps;
  auth: {
    requestCode: Mock<() => Promise<{ kind: "sent" }>>;
    verifyCode: Mock<() => Promise<{ kind: "verified"; userId: string }>>;
    signOut: Mock<() => Promise<void>>;
    deleteAccount: Mock<() => Promise<void>>;
  };
  persistence: {
    setPendingOtp: Mock;
    setPurchaseIntent: Mock;
  };
  retrySync: Mock<() => Promise<void>>;
};

type Binding = ReturnType<typeof createDesktopPopupBinding>;

type Listener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;

export const stops: (() => void)[] = [];

afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

export const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
};

export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Only the browser boundary is synthetic. Storage, authority serialization, router and binding are real. */
export async function browser() {
  const store: Record<string, unknown> = {
    "still:settings": {
      settings: structuredClone(DEFAULT_SETTINGS),
      syncMetadata: null,
    },
  };
  const listeners = new Set<Listener>();
  const set = vi.fn(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) {
      const oldValue = store[key];
      store[key] = structuredClone(value);
      for (const listener of [...listeners])
        listener(
          { [key]: { oldValue, newValue: structuredClone(value) } },
          "local",
        );
    }
  });
  const origin = "chrome-extension://synthetic/";
  const sendMessage = vi.fn(
    (message: unknown) =>
      new Promise((resolve) => {
        router(
          message,
          { id: "synthetic", url: origin + "popup.html" },
          resolve,
        );
      }),
  );
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) =>
          key in store ? { [key]: structuredClone(store[key]) } : {},
        set,
      },
      onChanged: {
        addListener: (l: Listener) => listeners.add(l),
        removeListener: (l: Listener) => listeners.delete(l),
      },
    },
    runtime: { id: "synthetic", getURL: () => origin, sendMessage },
  });
  const authority = new ChromeStorageAdapter({ authority: true });
  let commit = (intent: SettingsIntent) => authority.commitIntent(intent);
  const router = createSettingsIntentRouter(
    (intent) => commit(intent),
    "synthetic",
    origin,
  );
  await authority.initializeAtomic("never-linked");
  set.mockClear();
  return {
    authority,
    store,
    set,
    sendMessage,
    port(next: typeof commit) {
      commit = next;
    },
    async external(record: StoredSettingsRecord) {
      await set({ "still:settings": record });
    },
    /** A payload-free storage change (no parseable record): the cache must reread the slot. */
    invalidate() {
      for (const listener of [...listeners])
        listener({ "still:settings": { newValue: undefined } }, "local");
    },
  };
}

export function capture(
  options: {
    purchase?: ExtensionPurchaseDeps;
    analytics?: UiAnalytics;
    onLocalSettingsCommit?: (record: StoredSettingsRecord) => void;
  } = {},
) {
  let binding!: Binding;
  const controller = createExtensionUiController(options.purchase, {
    analytics: options.analytics,
    onLocalSettingsCommit: options.onLocalSettingsCommit,
    onCommittedPopupBinding(value) {
      binding = value;
      stops.push(value.stop);
    },
  });
  return { controller, binding };
}

export function globalSwitch() {
  return screen.getByRole("switch", {
    name: "Still on/off",
  }) as HTMLButtonElement;
}

export function serviceSwitch(id: string) {
  return within(
    document.querySelector(`[data-service="${id}"]`) as HTMLElement,
  ).getByRole("switch") as HTMLButtonElement;
}

export function mount(state: ReturnType<typeof capture>): RenderResult<typeof App> {
  return render(App, {
    controller: state.controller,
    compact: true,
    committedPopupBinding: state.binding,
  });
}

export function purchase(): PurchaseFixture {
  const auth = {
    requestCode: vi.fn(async () => ({ kind: "sent" as const })),
    verifyCode: vi.fn(async () => ({
      kind: "verified" as const,
      userId: "synthetic-account",
    })),
    signOut: vi.fn(async () => {}),
    deleteAccount: vi.fn(async () => {}),
  };
  const persistence = { setPendingOtp: vi.fn(), setPurchaseIntent: vi.fn() };
  const retrySync = vi.fn(async () => {});
  const deps: ExtensionPurchaseDeps = {
    auth,
    persistence,
    retrySync,
    displayPrice: "$1.99",
    getState: async () => ({
      userId: null,
      entitled: false,
      pendingOtp: null,
      checkoutPending: null,
    }),
    checkout: {
      createCheckout: async () => ({ kind: "unavailable" }),
      openCheckoutTab: async () => undefined,
      setPending: () => {},
      reconcile: async () => "unknown",
    },
  };
  return { deps, auth, persistence, retrySync };
}
