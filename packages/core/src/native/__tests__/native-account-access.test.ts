import { describe, expect, it, vi } from "vitest";
import { NativeBridge } from "../bridge.js";
import type { StillBridgeWindow } from "../../storage/wkwebview-adapter.js";
const ack = { schema: 1, status: "committed", generation: 2, accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", issuerTime: 1800000000000, proofIdentities: ["synthetic-access:" + "ab".repeat(64)] };
function host(reply: unknown) {
  const post = vi.fn(async () => reply);
  return { post, bridge: new NativeBridge({ webkit: { messageHandlers: { still: { postMessage: post } } } } as StillBridgeWindow) };
}
describe("native account-only reconciliation", () => {
  it("sends only transient Auth token and accepts actual committed readback", async () => {
    const h = host(ack);
    expect(await h.bridge.reconcileAccountAccess("transient-token")).toEqual(ack);
    expect(h.post).toHaveBeenCalledExactlyOnceWith({ kind: "reconcileAccountAccess", accessToken: "transient-token" });
  });
  it.each([null, {ok:true}, {...ack, entitled:true}, {...ack, generation:true}, {...ack, proofIdentities:["unsigned"]}, {...ack, proofIdentities:[ack.proofIdentities[0],ack.proofIdentities[0]]}, {...ack, status:"unavailable"}])("rejects fabricated readback %j", async reply => {
    await expect(host(reply).bridge.reconcileAccountAccess("transient-token")).rejects.toThrow();
  });
  it("never posts missing or oversized tokens", async () => {
    const h=host(ack);
    await expect(h.bridge.reconcileAccountAccess("")).rejects.toThrow();
    await expect(h.bridge.reconcileAccountAccess("x".repeat(16385))).rejects.toThrow();
    expect(h.post).not.toHaveBeenCalled();
  });
});
