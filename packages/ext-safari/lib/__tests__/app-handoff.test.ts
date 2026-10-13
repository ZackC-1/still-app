import { describe, expect, it, vi } from "vitest";
import { STILL_PRO_APP_URL, STILL_SYNC_APP_URL } from "@still/core/native";
import {
  SAFARI_APP_ROUTE_URLS,
  createSafariAppHandoff,
  type SafariAppHandoffPorts,
  type SafariAppRoute,
} from "../app-handoff.js";

function ports(reply: (message: { kind: string; route: SafariAppRoute }) => Promise<unknown>) {
  const calls: string[] = [];
  const value = {
    sendNative: vi.fn(async (message: { kind: "openAppRoute"; route: SafariAppRoute }) => {
      calls.push(`native:${message.kind}:${message.route}`);
      return reply(message);
    }),
    openTab: vi.fn(async (url: string) => void calls.push(`tab:${url}`)),
    close: vi.fn(() => void calls.push("close")),
  } satisfies SafariAppHandoffPorts;
  return { ports: value, calls };
}

const opened = async (message: { route: SafariAppRoute }) => ({
  openAppRoute: { ok: true, route: message.route },
});

describe("Safari popup hand-off to the Still app", () => {
  it("uses the same fixed links as the app and core", () => {
    expect(SAFARI_APP_ROUTE_URLS).toEqual({ pro: STILL_PRO_APP_URL, sync: STILL_SYNC_APP_URL });
    expect(Object.isFrozen(SAFARI_APP_ROUTE_URLS)).toBe(true);
  });

  it.each(["pro", "sync"] as const)("Mac: asks the native handler to open the app at %s, then closes", async (route) => {
    const { ports: p, calls } = ports(opened);
    await expect(createSafariAppHandoff("desktop", p)(route)).resolves.toBe("app");
    expect(p.sendNative).toHaveBeenCalledWith({ kind: "openAppRoute", route });
    expect(p.openTab).not.toHaveBeenCalled();
    expect(calls).toEqual([`native:openAppRoute:${route}`, "close"]);
  });

  it.each(["pro", "sync"] as const)("iPhone and iPad: opens the fixed %s link in a Safari tab, never the native lane", async (route) => {
    const { ports: p, calls } = ports(opened);
    await expect(createSafariAppHandoff("mobile", p)(route)).resolves.toBe("tab");
    expect(p.sendNative).not.toHaveBeenCalled();
    expect(calls).toEqual([`tab:still://${route}`, "close"]);
  });

  it.each([
    ["a refusal", async () => ({ openAppRoute: { ok: false, route: "pro" } })],
    ["a reply for another route", async () => ({ openAppRoute: { ok: true, route: "sync" } })],
    ["a settings-lane reply from an older app", async () => ({ settings: "" })],
    ["no reply", async () => undefined],
    ["a rejection", async () => Promise.reject(new Error("no native host"))],
  ])("Mac: falls back to the fixed tab link after %s", async (_name, reply) => {
    const { ports: p, calls } = ports(reply as never);
    await expect(createSafariAppHandoff("desktop", p)("pro")).resolves.toBe("tab");
    expect(calls).toEqual(["native:openAppRoute:pro", "tab:still://pro", "close"]);
  });

  it("reports a failed tab without closing the popup", async () => {
    const { ports: p } = ports(opened);
    p.openTab.mockRejectedValueOnce(new Error("blocked"));
    await expect(createSafariAppHandoff("mobile", p)("sync")).resolves.toBe("failed");
    expect(p.close).not.toHaveBeenCalled();
  });

  it("ignores a second tap while a hand-off is starting, then accepts the next one", async () => {
    let finish!: (value: unknown) => void;
    const { ports: p } = ports(() => new Promise((resolve) => (finish = resolve)));
    const handoff = createSafariAppHandoff("desktop", p);
    const first = handoff("pro");
    await expect(handoff("sync")).resolves.toBe("busy");
    finish({ openAppRoute: { ok: true, route: "pro" } });
    await expect(first).resolves.toBe("app");
    expect(p.sendNative).toHaveBeenCalledTimes(1);
    p.sendNative.mockImplementationOnce(async () => ({ openAppRoute: { ok: true, route: "sync" } }));
    await expect(handoff("sync")).resolves.toBe("app");
  });

  it("refuses any route outside the closed set without opening anything", async () => {
    const { ports: p } = ports(opened);
    const handoff = createSafariAppHandoff("desktop", p);
    for (const forged of ["checkout", "https://example.com", "toString", "__proto__"]) {
      await expect(handoff(forged as SafariAppRoute)).resolves.toBe("failed");
    }
    expect(p.sendNative).not.toHaveBeenCalled();
    expect(p.openTab).not.toHaveBeenCalled();
  });

  it("a popup that cannot close still counts as handed off", async () => {
    const { ports: p } = ports(opened);
    p.close.mockImplementation(() => {
      throw new Error("not allowed");
    });
    await expect(createSafariAppHandoff("desktop", p)("pro")).resolves.toBe("app");
  });
});
