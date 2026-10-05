import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptIntoApp, NATIVE_APP, parseAdoptionReply, pushSettingsToApp } from "../native-settings.js";
import type { StoredSettingsRecord } from "@still/core/storage";

const record: StoredSettingsRecord = {
  settings: {
    globalOn: false,
    services: { youtube: true, instagram: false, tiktok: false, facebook: false },
    pauses: [],
    updatedAt: 42,
  },
  syncMetadata: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("pushSettingsToApp", () => {
  it("sends a native `set` message carrying the record as a JSON string", async () => {
    const sendNativeMessage = vi.fn(
      (_app: string, _message: { kind: string; settings: string }) => Promise.resolve({}),
    );
    vi.stubGlobal("browser", { runtime: { sendNativeMessage } });

    await pushSettingsToApp(record);

    expect(sendNativeMessage).toHaveBeenCalledTimes(1);
    const call = sendNativeMessage.mock.calls[0];
    expect(call).toBeDefined();
    const [app, msg] = call!;
    expect(app).toBe(NATIVE_APP);
    expect(msg).toEqual({ kind: "set", settings: JSON.stringify(record) });
    // The native handler round-trips this exact shape into the App Group (SafariWebExtensionHandler).
    expect(JSON.parse(msg.settings).settings.updatedAt).toBe(42);
  });

  it("swallows a missing native host (extension running outside the app container)", async () => {
    const sendNativeMessage = vi.fn(() => Promise.reject(new Error("no native host")));
    vi.stubGlobal("browser", { runtime: { sendNativeMessage } });
    await expect(pushSettingsToApp(record)).resolves.toBeUndefined();
  });
});

describe("adoptIntoApp (owner decision 30)", () => {
  it("sends one native settingsAdopt carrying the stored record, never the per-reply flag", async () => {
    const reply = { settings: JSON.stringify({ status: "adopted", record }) };
    const sendNativeMessage = vi.fn((_app: string, _message: { kind: string; settings: string }) => Promise.resolve(reply));
    vi.stubGlobal("browser", { runtime: { sendNativeMessage } });
    await expect(adoptIntoApp({ ...record, intentCommitted: true })).resolves.toEqual({ status: "adopted", record });
    expect(sendNativeMessage).toHaveBeenCalledTimes(1);
    const [app, message] = sendNativeMessage.mock.calls[0]!;
    expect(app).toBe(NATIVE_APP);
    expect(Object.keys(message).sort()).toEqual(["kind", "settings"]);
    expect(message.kind).toBe("settingsAdopt");
    expect(JSON.parse(message.settings)).toEqual(record);
  });

  it("an unreachable app or unreadable reply is no answer", async () => {
    vi.stubGlobal("browser", { runtime: { sendNativeMessage: () => Promise.reject(new Error("no host")) } });
    await expect(adoptIntoApp(record)).resolves.toBeNull();
    for (const reply of [null, {}, { settings: "" }, { settings: "{" }, { settings: '{"status":"unavailable"}' },
      { settings: JSON.stringify({ status: "adopted", record: { settings: { globalOn: 1 } } }) }])
      expect(parseAdoptionReply(reply)).toBeNull();
    expect(parseAdoptionReply({ settings: JSON.stringify({ status: "kept", record: null }) })).toEqual({ status: "kept", record: null });
  });
});
