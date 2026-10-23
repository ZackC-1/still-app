import { describe, expect, it, vi } from "vitest";
import {
  EMAIL_PERMISSION_WITHDRAWN_KEY,
  FIREFOX_DATA_TYPES,
  dataPermission,
  firefoxDataGranted,
  firefoxDataPermission,
  pickDataPermission,
  watchEmailPermissionNotice,
  type FirefoxDataCollectionApi,
  type NoticePermissions,
  type NoticeStorage,
} from "../data-permission.js";
import { firefoxBrowserSpecificSettings } from "../../wxt.config.js";

// Firefox's optional data-collection permissions, page side. Mozilla's rules: an optional type is
// asked for with permissions.request({ data_collection }) from inside a user action, and the grants
// are listed in permissions.getAll().data_collection.

function api(initial: string[] = [], answer?: boolean) {
  const held = new Set(initial);
  const value = {
    request: vi.fn(async ({ data_collection }: { data_collection: string[] }) => {
      if (answer === undefined) throw new Error("permissions.request may only be called from a user input handler");
      if (answer) for (const type of data_collection) held.add(type);
      return answer;
    }),
    getAll: vi.fn(async () => ({ permissions: [], origins: [], data_collection: [...held] })),
  } satisfies FirefoxDataCollectionApi;
  return { value, held };
}

describe("Firefox's data types", () => {
  it("are the ones the manifest declares as optional", () => {
    const { optional, required } = firefoxBrowserSpecificSettings.gecko.data_collection_permissions;
    for (const type of Object.values(FIREFOX_DATA_TYPES)) {
      expect(optional).toContain(type);
      expect(required).not.toContain(type);
    }
  });
});

describe("ask", () => {
  it("calls permissions.request synchronously, with only the one type", () => {
    const fake = api([], true);
    const permission = firefoxDataPermission(() => fake.value);
    void permission.ask("email");
    // Before any microtask: Firefox only prompts while the click is still being handled.
    expect(fake.value.request).toHaveBeenCalledWith({ data_collection: ["personallyIdentifyingInfo"] });
    void permission.ask("purchase");
    expect(fake.value.request).toHaveBeenLastCalledWith({ data_collection: ["financialAndPaymentInfo"] });
  });

  it("granted at the prompt: true", async () => {
    const fake = api([], true);
    expect(await firefoxDataPermission(() => fake.value).ask("email")).toBe(true);
  });

  it("declined at the prompt: false", async () => {
    const fake = api([], false);
    expect(await firefoxDataPermission(() => fake.value).ask("purchase")).toBe(false);
  });

  it("outside a click Firefox refuses to ask: the current grant decides", async () => {
    expect(await firefoxDataPermission(() => api(["personallyIdentifyingInfo"]).value).ask("email")).toBe(true);
    expect(await firefoxDataPermission(() => api([]).value).ask("email")).toBe(false);
  });

  it("a missing API or a throwing request reads as not granted", async () => {
    expect(await firefoxDataPermission(() => undefined).ask("email")).toBe(false);
    const throwing = {
      request: () => {
        throw new Error("sync throw");
      },
      getAll: async () => ({}),
    } as unknown as FirefoxDataCollectionApi;
    expect(await firefoxDataPermission(() => throwing).ask("email")).toBe(false);
  });
});

describe("granted", () => {
  it("reads Firefox's own list every time, so a withdrawal shows at once", async () => {
    const fake = api(["financialAndPaymentInfo"]);
    const permission = firefoxDataPermission(() => fake.value);
    expect(await permission.granted("purchase")).toBe(true);
    expect(await permission.granted("email")).toBe(false);
    fake.held.delete("financialAndPaymentInfo"); // withdrawn in about:addons
    expect(await permission.granted("purchase")).toBe(false);
    expect(fake.value.getAll).toHaveBeenCalledTimes(3);
    expect(fake.value.request).not.toHaveBeenCalled();
  });

  it("a browser without built-in consent (no data_collection key) is not granted", async () => {
    const legacy = { request: vi.fn(), getAll: async () => ({ permissions: [] }) } as unknown as FirefoxDataCollectionApi;
    expect(await firefoxDataGranted(() => legacy, "email")).toBe(false);
  });
});

describe("Chrome and Safari never touch Firefox's permission API", () => {
  it("their builds get no DataPermission", () => {
    const fake = api([], true);
    expect(pickDataPermission(false, () => fake.value)).toBeUndefined();
    expect(fake.value.request).not.toHaveBeenCalled();
    expect(fake.value.getAll).not.toHaveBeenCalled();
    // This test environment is not the Firefox build either.
    expect(dataPermission).toBeUndefined();
  });

  it("the Firefox build gets one", () => {
    expect(pickDataPermission(true, () => api().value)).toBeDefined();
  });
});

describe("the withdrawn notice on Firefox pages", () => {
  type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;
  function harness(options: { withdrawn: boolean; granted: boolean }) {
    const items: Record<string, unknown> = options.withdrawn ? { [EMAIL_PERMISSION_WITHDRAWN_KEY]: true } : {};
    let changed: Listener | null = null;
    let added: ((permissions: { data_collection?: string[] }) => void) | null = null;
    let granted = options.granted;
    const storage: NoticeStorage = {
      get: async (key) => (key in items ? { [key]: items[key] } : {}),
      onChanged: { addListener: (l) => void (changed = l), removeListener: () => void (changed = null) },
    };
    const permissions: NoticePermissions = {
      granted: async () => granted,
      onAdded: { addListener: (l) => void (added = l), removeListener: () => void (added = null) },
    };
    const controller = { showEmailPermissionWithdrawn: vi.fn(), clearEmailPermissionWithdrawn: vi.fn() };
    const stop = watchEmailPermissionNotice(controller, storage, permissions);
    return {
      controller,
      stop,
      grant(next: boolean) {
        granted = next;
      },
      setFlag(value: boolean) {
        if (value) items[EMAIL_PERMISSION_WITHDRAWN_KEY] = true;
        else delete items[EMAIL_PERMISSION_WITHDRAWN_KEY];
        changed?.({ [EMAIL_PERMISSION_WITHDRAWN_KEY]: { newValue: value ? true : undefined } }, "local");
      },
      add(types: string[]) {
        added?.({ data_collection: types });
      },
      get listening() {
        return changed !== null || added !== null;
      },
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("shows the sign-in line when the background signed the account out and the grant is still missing", async () => {
    const h = harness({ withdrawn: true, granted: false });
    await settle();
    expect(h.controller.showEmailPermissionWithdrawn).toHaveBeenCalledOnce();
  });

  it("does not show it once the permission is granted again (about:addons or Send code)", async () => {
    const h = harness({ withdrawn: true, granted: true });
    await settle();
    expect(h.controller.showEmailPermissionWithdrawn).not.toHaveBeenCalled();
    expect(h.controller.clearEmailPermissionWithdrawn).toHaveBeenCalled();
  });

  it("follows a withdrawal while the page is open, and clears when Firefox reports the grant added", async () => {
    const h = harness({ withdrawn: false, granted: false });
    await settle();
    expect(h.controller.showEmailPermissionWithdrawn).not.toHaveBeenCalled();
    h.setFlag(true);
    await settle();
    expect(h.controller.showEmailPermissionWithdrawn).toHaveBeenCalledOnce();
    h.grant(true);
    h.add(["technicalAndInteraction"]);
    await settle();
    expect(h.controller.clearEmailPermissionWithdrawn).not.toHaveBeenCalled();
    h.add(["personallyIdentifyingInfo"]);
    await settle();
    expect(h.controller.clearEmailPermissionWithdrawn).toHaveBeenCalled();
    h.stop();
    expect(h.listening).toBe(false);
  });
});
