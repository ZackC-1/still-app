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
    "commits %s straight to native and confirms it",
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

  it("Don't share stops web reporting at the tap, before native answers", async () => {
    const { host, adopt, consent } = committer();
    const pending = consent.commit(false);
    // Nothing has been awaited yet: the native write has not even replied.
    expect(adopt).toHaveBeenCalledExactlyOnceWith(false);
    expect(host.native.stored).toBeUndefined();
    expect(await pending).toBe(true);
    expect(adopt).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each([
    ["the read-back fails after a successful write", (h: ReturnType<typeof fakeAppleConsentHost>) => (h.native.firstContextMs = Infinity)],
    ["the write is refused", (h: ReturnType<typeof fakeAppleConsentHost>) => (h.native.refuseWrite = true)],
    ["the write never lands", (h: ReturnType<typeof fakeAppleConsentHost>) => (h.native.writesOff = false)],
  ])("web reporting stays off when %s", async (_label, breakIt) => {
    vi.useFakeTimers();
    const { host, adopt, consent } = committer();
    breakIt(host);
    const pending = consent.commit(false);
    await vi.advanceTimersByTimeAsync(APPLE_CONSENT_CONFIRM_DEADLINE_MS);
    expect(await pending).toBe(false);
    expect(adopt.mock.calls).toEqual([[false]]);
  });

  it("Share is adopted only after native confirmed it", async () => {
    const { adopt, consent } = committer();
    const pending = consent.commit(true);
    expect(adopt).not.toHaveBeenCalled();
    expect(await pending).toBe(true);
    expect(adopt).toHaveBeenCalledExactlyOnceWith(true);
  });

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
    expect(adopt.mock.calls).toEqual([[false]]); // web reporting still stopped at the tap
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
    expect(adopt).not.toHaveBeenCalled();
    bridge.observeAnalyticsConsent = vi.fn(async () => ({
      consent: true,
      answered: true,
    }));
    expect(await consent.commit(false)).toBe(false); // stored value differs
    expect(await consent.commit(true)).toBe(true);
    expect(adopt.mock.calls).toEqual([[false], [true]]);
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
    expect(adopt.mock.calls).toEqual([[false]]); // the superseded Share is never adopted
  });
});

describe("first-launch timing", () => {
  it("waits beyond the native 5 s iCloud wait for the confirming read", async () => {
    expect(APPLE_CONSENT_CONFIRM_DEADLINE_MS).toBeGreaterThan(5_000);
    vi.useFakeTimers();
    const { host, consent } = committer();
    host.native.firstContextMs = 6_000;
    const result = consent.commit(false);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await result).toBe(true);
  });

  it("a confirmation after warm() joins the one in-flight launch read", async () => {
    vi.useFakeTimers();
    const { host, consent } = committer();
    host.native.firstContextMs = 6_000;
    consent.warm();
    await vi.advanceTimersByTimeAsync(4_000); // the person reaches the consent step
    let result: boolean | undefined;
    void consent.commit(true).then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(true); // answered 2 s after the tap, not a fresh 6 s wait
    expect(host.native.contextComputations).toBe(1);
    expect(host.posted("analyticsContext")).toBe(2);
  });

  it("a launch read that never finishes fails at the deadline and changes nothing", async () => {
    vi.useFakeTimers();
    const { host, adopt, consent } = committer();
    host.native.firstContextMs = Infinity;
    const first = consent.commit(true);
    await vi.advanceTimersByTimeAsync(APPLE_CONSENT_CONFIRM_DEADLINE_MS);
    expect(await first).toBe(false);
    expect(adopt).not.toHaveBeenCalled();
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
