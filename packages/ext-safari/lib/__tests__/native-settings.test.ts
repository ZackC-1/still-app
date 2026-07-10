import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_APP, pushSettingsToApp } from "../native-settings.js";
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
    const sendNativeMessage = vi.fn(() => Promise.resolve({}));
    vi.stubGlobal("browser", { runtime: { sendNativeMessage } });

    await pushSettingsToApp(record);

    expect(sendNativeMessage).toHaveBeenCalledTimes(1);
    const [app, msg] = sendNativeMessage.mock.calls[0]!;
    expect(app).toBe(NATIVE_APP);
    expect(msg).toEqual({ kind: "set", settings: JSON.stringify(record) });
    // The native handler round-trips this exact shape into the App Group (SafariWebExtensionHandler).
    expect(JSON.parse((msg as { settings: string }).settings).settings.updatedAt).toBe(42);
  });

  it("swallows a missing native host (extension running outside the app container)", async () => {
    const sendNativeMessage = vi.fn(() => Promise.reject(new Error("no native host")));
    vi.stubGlobal("browser", { runtime: { sendNativeMessage } });
    await expect(pushSettingsToApp(record)).resolves.toBeUndefined();
  });
});
