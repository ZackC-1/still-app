import { describe, expect, it, vi } from "vitest";
import { NativeBridge } from "../bridge.js";
import type {
  StillBridgeWindow,
  StillMessagePort,
} from "../../storage/wkwebview-adapter.js";

const mac = {
  ok: true,
  platform: "macos",
  extensionStatus: "enabled",
  enableLocation: "safariExtensionSettings",
};
const ios = {
  ok: true,
  platform: "ios",
  extensionStatus: "unknown",
  enableLocation: "settingsAppStillPage",
};
function host(reply: unknown) {
  const port = { postMessage: vi.fn(async (_message: unknown) => reply) };
  const win: StillBridgeWindow = {
    webkit: { messageHandlers: { still: port } },
  };
  return { port, win, bridge: new NativeBridge(win) };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function replace(win: StillBridgeWindow, port?: StillMessagePort) {
  win.webkit = port ? { messageHandlers: { still: port } } : undefined;
}

describe("NativeBridge Safari setup observation", () => {
  it.each([
    ["mac enabled", mac],
    ["mac disabled", { ...mac, extensionStatus: "disabled" }],
    ["mac unknown", { ...mac, extensionStatus: "unknown" }],
    ["ios unknown", ios],
  ])(
    "accepts %s from object and JSON, posting only a pure read",
    async (_label, reply) => {
      for (const raw of [reply, JSON.stringify(reply)]) {
        const h = host(raw);
        expect(await h.bridge.observeSafariSetup()).toEqual(reply);
        expect(h.port.postMessage.mock.calls).toEqual([
          [{ kind: "safariSetupState" }],
        ]);
      }
    },
  );

  it("returns unavailable for an absent native host rather than claiming actual ios unknown", async () => {
    expect(await new NativeBridge({}).observeSafariSetup()).toBeNull();
    expect(await host(ios).bridge.observeSafariSetup()).not.toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["malformed JSON", "{"],
    ["array", [mac]],
    ["JSON array", JSON.stringify([mac])],
    ["boolean", true],
    ["number", 1],
    ["missing fields", { ok: true }],
    ["missing ok", { ...mac, ok: undefined }],
    ["false ok", { ...mac, ok: false }],
    ["truthy ok", { ...mac, ok: "true" }],
    ["wrong platform", { ...mac, platform: "mac" }],
    ["wrong status", { ...mac, extensionStatus: "on" }],
    ["wrong location", { ...mac, enableLocation: "safari" }],
    ["ios enabled", { ...ios, extensionStatus: "enabled" }],
    ["ios disabled", { ...ios, extensionStatus: "disabled" }],
    [
      "ios mac destination",
      { ...ios, enableLocation: "safariExtensionSettings" },
    ],
    ["mac ios destination", { ...mac, enableLocation: "settingsAppStillPage" }],
  ])(
    "rejects %s instead of manufacturing setup truth",
    async (_label, reply) => {
      expect(await host(reply).bridge.observeSafariSetup()).toBeNull();
    },
  );

  it("returns unavailable when the real post promise rejects or throws", async () => {
    const h = host(mac);
    h.port.postMessage.mockRejectedValueOnce(new Error("native read failed"));
    expect(await h.bridge.observeSafariSetup()).toBeNull();
    h.port.postMessage.mockImplementationOnce(() => {
      throw new Error("native port stopped");
    });
    expect(await h.bridge.observeSafariSetup()).toBeNull();
  });

  it.each(["replacement", "disappearance"])(
    "discards an enabled completion after port %s",
    async (change) => {
      const pending = deferred();
      const h = host(mac);
      h.port.postMessage.mockReturnValueOnce(pending.promise);
      const read = h.bridge.observeSafariSetup();
      replace(h.win, change === "replacement" ? host(ios).port : undefined);
      pending.resolve(mac);
      expect(await read).toBeNull();
    },
  );

  it.each(["unknown", "malformed", "rejected", "absent-host"])(
    "a newer %s read supersedes older enabled truth",
    async (kind) => {
      const pending = deferred();
      const h = host(mac);
      h.port.postMessage.mockReturnValueOnce(pending.promise);
      const old = h.bridge.observeSafariSetup();
      if (kind === "unknown") h.port.postMessage.mockResolvedValueOnce(ios);
      if (kind === "malformed")
        h.port.postMessage.mockResolvedValueOnce({ ok: false });
      if (kind === "rejected")
        h.port.postMessage.mockRejectedValueOnce(
          new Error("native unavailable"),
        );
      if (kind === "absent-host") replace(h.win);
      expect(await h.bridge.observeSafariSetup()).toEqual(
        kind === "unknown" ? ios : null,
      );
      // Returning to A does not restore an older request after an observed intervening read.
      replace(h.win, h.port);
      pending.resolve(mac);
      expect(await old).toBeNull();
    },
  );

  it("preserves the newest read when the older promise rejects late", async () => {
    const pending = deferred();
    const h = host(ios);
    h.port.postMessage.mockReturnValueOnce(pending.promise);
    const old = h.bridge.observeSafariSetup();
    expect(await h.bridge.observeSafariSetup()).toEqual(ios);
    pending.reject(new Error("old unavailable"));
    expect(await old).toBeNull();
    expect(await h.bridge.observeSafariSetup()).toEqual(ios);
  });
});
