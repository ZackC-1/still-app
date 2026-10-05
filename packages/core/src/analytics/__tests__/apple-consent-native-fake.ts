import { vi } from "vitest";
import { NativeBridge } from "../../native/bridge.js";
import type { StillBridgeWindow } from "../../storage/wkwebview-adapter.js";

/** A real-shaped Apple host for consent: a `NativeBridge` over a port that behaves like
 * WebBridgeRouter + AnalyticsIdentityStore. Sharing reads ON while the App Group key is unset
 * (`consent ?? true`), and `answered` / `consentAnswered` report whether a choice was written.
 * Switches model the failure paths: a writer that does not write (or never writes Don't share),
 * an older native reply without `answered`, a refusing writer, and a slow first context read. */
export function fakeAppleConsentHost() {
  const native = {
    stored: undefined as boolean | undefined,
    writes: true,
    writesOff: true,
    replyAnswered: true,
    refuseWrite: false,
    /** Milliseconds each analyticsContext reply waits, consumed front to back; Infinity never answers. */
    contextDelays: [] as number[],
  };
  const consent = () => native.stored ?? true;
  const answered = () => native.stored !== undefined;
  const port = {
    postMessage: vi.fn(async (message: unknown): Promise<unknown> => {
      const { kind, enabled } = message as { kind: string; enabled?: unknown };
      if (kind === "setAnalyticsConsent") {
        if (native.refuseWrite) throw new Error("still: setAnalyticsConsent refused");
        if (typeof enabled !== "boolean") throw new Error("still: setAnalyticsConsent missing enabled");
        if (native.writes && (enabled || native.writesOff)) native.stored = enabled;
        return JSON.stringify(
          native.replyAnswered
            ? { ok: true, enabled: consent(), answered: answered() }
            : { ok: true, enabled: consent() },
        );
      }
      if (kind === "analyticsContext") {
        const wait = native.contextDelays.shift() ?? 0;
        if (wait === Infinity) return new Promise(() => {});
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        return JSON.stringify({
          platform: "ios",
          appVersion: "2.1.0",
          installId: "11111111-1111-4111-8111-111111111111",
          anchorId: "22222222-2222-4222-8222-222222222222",
          created: true,
          returning: false,
          previousVersion: null,
          consent: consent(),
          consentAnswered: answered(),
          noticeSeen: false,
          extensionEnabled: null,
          device: "phone",
        });
      }
      throw new Error(`still: unknown kind ${kind}`);
    }),
  };
  const win: StillBridgeWindow = { webkit: { messageHandlers: { still: port } } };
  const bridge = new NativeBridge(win);
  const posted = (kind: string) =>
    port.postMessage.mock.calls.filter(
      ([m]) => (m as { kind: string }).kind === kind,
    ).length;
  return { native, port, bridge, posted };
}
