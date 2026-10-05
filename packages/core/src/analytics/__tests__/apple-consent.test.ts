import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPLE_CONSENT_CONFIRM_DEADLINE_MS,
  createAppleConsentCommitter,
  type AppleConsentBridge,
} from "../apple-consent.js";
import { fakeAppleConsentHost } from "./apple-consent-native-fake.js";

afterEach(() => {
  vi.useRealTimers();
});

function committer(host = fakeAppleConsentHost()) {
  const adopt = vi.fn();
  return {
    host,
    adopt,
    consent: createAppleConsentCommitter({ bridge: host.bridge, adopt }),
  };
}

describe("Apple consent commit through the native writer", () => {
  it.each([true, false])(
    "commits %s straight to native, confirms it, then adopts it",
    async (enabled) => {
      const { host, adopt, consent } = committer();
      expect(await consent.commit(enabled)).toBe(true);
      expect(host.native.stored).toBe(enabled);
      expect(host.port.postMessage.mock.calls.map(([m]) => m)).toEqual([
        { kind: "setAnalyticsConsent", enabled },
        { kind: "analyticsContext" },
      ]);
      expect(adopt).toHaveBeenCalledExactlyOnceWith(enabled);
    },
  );

  it("the on-by-default value never confirms Share when nothing was written", async () => {
    const { host, adopt, consent } = committer();
    host.native.writes = false;
    expect(await consent.commit(true)).toBe(false);
    expect(host.native.stored).toBeUndefined();
    expect(adopt).not.toHaveBeenCalled();
  });

  it("a writer that never writes Don't share leaves sharing on and is never confirmed", async () => {
    const { host, adopt, consent } = committer();
    host.native.writesOff = false; // like a permission-gated path that never reaches native
    expect(await consent.commit(false)).toBe(false);
    expect(host.native.stored).toBeUndefined();
    expect(adopt).not.toHaveBeenCalled();
  });

  it("an older native reply without the answered marker is not trusted", async () => {
    const { host, consent } = committer();
    host.native.replyAnswered = false;
    expect(await consent.commit(false)).toBe(false);
    expect(host.posted("analyticsContext")).toBe(0);
  });

  it("a refused write fails without a read-back", async () => {
    const { host, consent } = committer();
    host.native.refuseWrite = true;
    expect(await consent.commit(false)).toBe(false);
    expect(host.posted("analyticsContext")).toBe(0);
  });

  it("a writer that reports success is still checked against an explicit stored answer", async () => {
    const adopt = vi.fn();
    const bridge: AppleConsentBridge = {
      commitAnalyticsConsent: vi.fn(async () => true),
      observeAnalyticsConsent: vi.fn(async () => ({
        consent: true,
        answered: false,
      })),
    };
    const consent = createAppleConsentCommitter({ bridge, adopt });
    expect(await consent.commit(true)).toBe(false);
    bridge.observeAnalyticsConsent = vi.fn(async () => ({
      consent: true,
      answered: true,
    }));
    expect(await consent.commit(false)).toBe(false); // stored value differs
    expect(await consent.commit(true)).toBe(true);
    expect(adopt).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("an unreadable read-back is a failure", async () => {
    const bridge: AppleConsentBridge = {
      commitAnalyticsConsent: async () => true,
      observeAnalyticsConsent: async () => null,
    };
    expect(await createAppleConsentCommitter({ bridge }).commit(false)).toBe(
      false,
    );
  });

  it("a newer commit supersedes an older one still confirming", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const adopt = vi.fn();
    let first = true;
    const bridge: AppleConsentBridge = {
      commitAnalyticsConsent: async () => true,
      observeAnalyticsConsent: async () => {
        if (first) {
          first = false;
          await hold;
          return { consent: true, answered: true };
        }
        return { consent: false, answered: true };
      },
    };
    const observe = vi.spyOn(bridge, "observeAnalyticsConsent");
    const consent = createAppleConsentCommitter({ bridge, adopt });
    const older = consent.commit(true);
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    expect(await consent.commit(false)).toBe(true);
    release();
    expect(await older).toBe(false);
    expect(adopt).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("first-launch timing", () => {
  it("waits beyond the native 5 s iCloud wait for the confirming read", async () => {
    expect(APPLE_CONSENT_CONFIRM_DEADLINE_MS).toBeGreaterThan(5_000);
    vi.useFakeTimers();
    const { host, consent } = committer();
    host.native.contextDelays = [6_000];
    const result = consent.commit(false);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await result).toBe(true);
  });

  it("a first read that never answers fails at the deadline, then a fast retry succeeds", async () => {
    vi.useFakeTimers();
    const { host, consent } = committer();
    host.native.contextDelays = [Infinity];
    const first = consent.commit(false);
    await vi.advanceTimersByTimeAsync(APPLE_CONSENT_CONFIRM_DEADLINE_MS);
    expect(await first).toBe(false);
    expect(await consent.commit(false)).toBe(true);
  });

  it("warm starts the context read without writing anything", async () => {
    const { host, consent } = committer();
    consent.warm();
    await Promise.resolve();
    await Promise.resolve();
    expect(host.posted("analyticsContext")).toBe(1);
    expect(host.posted("setAnalyticsConsent")).toBe(0);
    expect(host.native.stored).toBeUndefined();
  });
});
