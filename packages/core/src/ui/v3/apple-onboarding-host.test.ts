import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAppleOnboardingHost,
  setupActionLabel,
  setupDetection,
  setupSteps,
  type AppleOnboardingHostBridge,
  type AppleOnboardingHostDeps,
  type AppleOnboardingHostView,
} from "./apple-onboarding-host.js";
import type {
  OnboardingStateReply,
  SafariSetupObservation,
} from "../../native/bridge.js";
import type { AppleOnboardingProps } from "./apple-onboarding-presentation.js";
import { createAppleConsentCommitter } from "../../analytics/apple-consent.js";
import { fakeAppleConsentHost } from "../../analytics/__tests__/apple-consent-native-fake.js";

const iosState: OnboardingStateReply = {
  ok: true,
  shouldShow: true,
  platform: "ios",
  osMajorVersion: 18,
};
const macState: OnboardingStateReply = {
  ...iosState,
  platform: "macos",
  osMajorVersion: 15,
};
const mac = (
  extensionStatus: "enabled" | "disabled" | "unknown",
): SafariSetupObservation => ({
  ok: true,
  platform: "macos",
  extensionStatus,
  enableLocation: "safariExtensionSettings",
});
const ios: SafariSetupObservation = {
  ok: true,
  platform: "ios",
  extensionStatus: "unknown",
  enableLocation: "settingsAppStillPage",
};
const purposes = [{ name: "Caller purpose", text: "Caller-approved text" }];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The shared committer over a real `NativeBridge` and a router-shaped native consent store whose
 * unset default reads on. */
function nativeConsent() {
  const host = fakeAppleConsentHost();
  const adopt = vi.fn();
  const committer = createAppleConsentCommitter({ bridge: host.bridge, adopt });
  const commit = vi.fn((enabled: boolean) => committer.commit(enabled));
  const warm = vi.fn(() => committer.warm());
  return { ...host, adopt, commit, warm };
}

function harness(
  options: {
    state?: OnboardingStateReply | null;
    observation?: SafariSetupObservation | null;
    complete?: boolean;
    sharing?: ReturnType<typeof nativeConsent> | null;
    purposesVerified?: boolean;
    purposes?: AppleOnboardingHostDeps["consent"]["purposes"];
    openSetup?: boolean;
    consentDeadlineMs?: number;
    destinations?: AppleOnboardingHostDeps["destinations"];
  } = {},
) {
  const bridge = {
    onboardingState: vi.fn<AppleOnboardingHostBridge["onboardingState"]>(
      async () => (options.state === undefined ? iosState : options.state),
    ),
    completeOnboarding: vi.fn<AppleOnboardingHostBridge["completeOnboarding"]>(
      async () => options.complete ?? true,
    ),
    observeSafariSetup: vi.fn<AppleOnboardingHostBridge["observeSafariSetup"]>(
      async () =>
        options.observation === undefined ? ios : options.observation,
    ),
  };
  const sharing =
    options.sharing === null ? undefined : (options.sharing ?? nativeConsent());
  const onDone = vi.fn();
  const openSetup = vi.fn();
  const openSafari = vi.fn();
  const views: AppleOnboardingHostView[] = [];
  const consent: AppleOnboardingHostDeps["consent"] = {
    purposes: options.purposes ?? purposes,
    purposesVerified: options.purposesVerified ?? true,
    sharing: sharing && { commit: sharing.commit, warm: sharing.warm },
  };
  const host = createAppleOnboardingHost({
    bridge,
    openSetup: options.openSetup === false ? undefined : openSetup,
    openSafari,
    destinations: options.destinations,
    consent,
    onDone,
    onChange: (view) => views.push(view),
    deadlineMs: 50,
    consentDeadlineMs: options.consentDeadlineMs,
  });
  const props = (): AppleOnboardingProps => {
    const view = host.view;
    if (!view.visible) throw new Error("onboarding is hidden");
    return view.props;
  };
  return { bridge, sharing, onDone, openSetup, openSafari, views, host, props };
}

async function toStep(
  h: ReturnType<typeof harness>,
  step: 2 | 3 | 4,
): Promise<void> {
  await h.host.start();
  h.props().onContinue?.();
  await flush();
  if (step === 2) return;
  if (h.props().platform === "ios") h.props().onAssertEnabled?.();
  else h.props().onDoLater?.();
  if (step === 3 || h.props().step !== 3) return;
  h.props().consent.onDecline?.();
  for (let i = 0; i < 6; i++) await flush();
  h.props().onContinue?.();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("approved setup wording", () => {
  it("uses the iOS 18+ Settings path from iOS 18", () => {
    for (const major of [18, 19, 26])
      expect(setupSteps("ios", major)).toEqual([
        "Open the Settings app.",
        "Go to Apps, then Safari, then Extensions.",
        "Turn on Still and allow it on every website.",
      ]);
  });

  it("uses the older Settings path on iOS 15 to 17", () => {
    for (const major of [15, 16, 17])
      expect(setupSteps("ios", major)).toEqual([
        "Open the Settings app.",
        "Go to Safari, then Extensions.",
        "Turn on Still and allow it on every website.",
      ]);
  });

  it("uses the macOS steps on every macOS version", () => {
    for (const major of [12, 15, 26])
      expect(setupSteps("mac", major)).toEqual([
        "Open Safari, then Settings, then Extensions.",
        "Turn on Still.",
        "Allow it on every website.",
      ]);
  });

  it("names the button for where each platform opens", () => {
    expect(setupActionLabel("ios")).toBe("Open Settings");
    expect(setupActionLabel("mac")).toBe("Open Safari Settings");
  });

  it.each([
    [17, "Go to Safari, then Extensions."],
    [18, "Go to Apps, then Safari, then Extensions."],
  ])(
    "the host passes the native iOS %i fact into step 2",
    async (major, line) => {
      const h = harness({ state: { ...iosState, osMajorVersion: major } });
      await toStep(h, 2);
      expect(h.props().setup?.steps[1]).toBe(line);
      expect(h.props().setup?.actionLabel).toBe("Open Settings");
    },
  );

  it("the host uses the macOS steps for a macOS gate reply", async () => {
    const h = harness({ state: macState, observation: mac("disabled") });
    await toStep(h, 2);
    expect(h.props().platform).toBe("mac");
    expect(h.props().setup?.steps).toEqual(setupSteps("mac", 15));
    expect(h.props().setup?.actionLabel).toBe("Open Safari Settings");
  });
});

describe("Safari setup detection", () => {
  it("never claims enabled on iOS", () => {
    for (const observation of [ios, mac("enabled"), null])
      for (const opened of [false, true])
        expect(setupDetection("ios", observation, opened)).toBeUndefined();
  });

  it("treats only a macOS enabled observation as on", () => {
    expect(setupDetection("mac", mac("enabled"), false)).toEqual({
      state: "on",
      verified: true,
    });
    expect(setupDetection("mac", mac("unknown"), true)).toBeUndefined();
    expect(setupDetection("mac", null, true)).toBeUndefined();
    expect(setupDetection("mac", ios, true)).toBeUndefined();
    expect(setupDetection("mac", mac("disabled"), false)).toBeUndefined();
    expect(setupDetection("mac", mac("disabled"), true)).toEqual({
      state: "waiting",
      verified: true,
    });
  });
});

describe("the one native gate decides visibility", () => {
  it.each([
    ["shouldShow false", { ...iosState, shouldShow: false }],
    ["no reply", null],
  ])("stays hidden for %s", async (_label, state) => {
    const h = harness({ state });
    await h.host.start();
    expect(h.host.view).toEqual({ visible: false, done: false });
    expect(h.bridge.completeOnboarding).not.toHaveBeenCalled();
  });

  it("stays hidden when the gate read never answers", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.bridge.onboardingState.mockImplementation(() => new Promise(() => {}));
    const started = h.host.start();
    await vi.advanceTimersByTimeAsync(50);
    await started;
    expect(h.host.view).toEqual({ visible: false, done: false });
  });

  it("shows step 1 only for an explicit shouldShow true, reading the gate once", async () => {
    const h = harness();
    await h.host.start();
    await h.host.start();
    expect(h.bridge.onboardingState).toHaveBeenCalledOnce();
    expect(h.props().step).toBe(1);
    expect(h.props().platform).toBe("ios");
    expect(h.props().onBack).toBeUndefined();
  });
});

describe("step 2", () => {
  it("reads setup when entering step 2 and iOS advances only on the user's assertion", async () => {
    const h = harness();
    await toStep(h, 2);
    expect(h.bridge.observeSafariSetup).toHaveBeenCalledOnce();
    expect(h.props().step).toBe(2);
    expect(h.props().detection).toBeUndefined();
    expect(h.props().onDoLater).toBeUndefined();
    h.props().onContinue?.();
    expect(h.props().step).toBe(2);
    h.props().setup?.onOpen?.();
    expect(h.openSetup).toHaveBeenCalledExactlyOnceWith("settingsAppStillPage");
    h.props().onAssertEnabled?.();
    expect(h.props().step).toBe(3);
  });

  it("a macOS enabled observation shows on and allows Continue", async () => {
    const h = harness({ state: macState, observation: mac("enabled") });
    await toStep(h, 2);
    expect(h.props().detection).toEqual({ state: "on", verified: true });
    expect(h.props().onAssertEnabled).toBeUndefined();
    h.props().setup?.onOpen?.();
    expect(h.openSetup).not.toHaveBeenCalled();
    h.props().onContinue?.();
    expect(h.props().step).toBe(3);
  });

  it("macOS shows waiting after opening settings and on after a foreground refresh", async () => {
    const h = harness({ state: macState, observation: mac("disabled") });
    await toStep(h, 2);
    expect(h.props().detection).toBeUndefined();
    h.props().setup?.onOpen?.();
    expect(h.props().detection).toEqual({ state: "waiting", verified: true });
    h.props().onContinue?.();
    expect(h.props().step).toBe(2);
    h.bridge.observeSafariSetup.mockResolvedValueOnce(mac("enabled"));
    await h.host.refreshSetup();
    expect(h.props().detection?.state).toBe("on");
  });

  it("a setup read that times out claims nothing", async () => {
    vi.useFakeTimers();
    const h = harness({ state: macState });
    h.bridge.observeSafariSetup.mockImplementation(() => new Promise(() => {}));
    await h.host.start();
    h.props().onContinue?.();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.props().detection).toBeUndefined();
    h.props().onContinue?.();
    expect(h.props().step).toBe(2);
    h.props().onDoLater?.();
    expect(h.props().step).toBe(3);
  });

  it("a late setup read cannot land after leaving step 2 or over a newer read", async () => {
    const h = harness({ state: macState });
    const first = deferred<SafariSetupObservation | null>();
    h.bridge.observeSafariSetup.mockReturnValueOnce(first.promise);
    await h.host.start();
    h.props().onContinue?.();
    h.props().onDoLater?.();
    first.resolve(mac("enabled"));
    await flush();
    expect(h.props().step).toBe(3);
    const older = deferred<SafariSetupObservation | null>();
    h.bridge.observeSafariSetup.mockReturnValueOnce(older.promise);
    h.bridge.observeSafariSetup.mockResolvedValueOnce(mac("disabled"));
    // Re-entering step 2 starts `older`; the refresh then starts a newer read.
    h.props().onBack?.();
    await h.host.refreshSetup();
    older.resolve(mac("enabled"));
    await flush();
    expect(h.props().detection).toBeUndefined();
  });

  it("the setup button is disabled when the host cannot open the location", async () => {
    const h = harness({ openSetup: false });
    await toStep(h, 2);
    expect(h.props().setup?.onOpen).toBeUndefined();
  });
});

const settled = async () => {
  for (let i = 0; i < 6; i++) await flush();
};

describe("consent never shares on its own", () => {
  it("walking the whole flow without a choice never writes consent", async () => {
    const h = harness();
    await toStep(h, 3);
    h.props().onContinue?.();
    expect(h.props().step).toBe(3);
    expect(h.props().consent.status).toBe("unasked");
    expect(h.sharing?.commit).not.toHaveBeenCalled();
    expect(h.sharing?.posted("setAnalyticsConsent")).toBe(0);
    expect(h.sharing?.native.stored).toBeUndefined();
  });

  it("warms the native context read when onboarding starts, before step 3", async () => {
    const h = harness();
    await h.host.start();
    await flush();
    expect(h.props().step).toBe(1);
    expect(h.sharing?.warm).toHaveBeenCalledOnce();
    expect(h.sharing?.posted("analyticsContext")).toBe(1);
    expect(h.sharing?.posted("setAnalyticsConsent")).toBe(0);
  });

  it("does not ask the native gate's hidden flow to warm anything", async () => {
    const h = harness({ state: { ...iosState, shouldShow: false } });
    await h.host.start();
    expect(h.sharing?.warm).not.toHaveBeenCalled();
  });

  it("Share writes native once and is saved only when native confirms an explicit on", async () => {
    const h = harness();
    await toStep(h, 3);
    h.props().consent.onShare?.();
    h.props().consent.onShare?.();
    expect(h.sharing?.commit).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.props().consent.status).toBe("saving");
    await settled();
    expect(h.sharing?.native.stored).toBe(true);
    expect(h.props().consent).toMatchObject({ status: "saved", choice: "on" });
    expect(h.sharing?.adopt).toHaveBeenCalledExactlyOnceWith(true);
    h.props().onContinue?.();
    expect(h.props().step).toBe(4);
  });

  it("Share is never Saved from the on-by-default value when nothing was written", async () => {
    const sharing = nativeConsent();
    sharing.native.writes = false;
    const h = harness({ sharing });
    await toStep(h, 3);
    h.props().consent.onShare?.();
    await settled();
    expect(sharing.native.stored).toBeUndefined();
    expect(h.props().consent.status).toBe("failed");
    expect(
      h.views.some((v) => v.visible && v.props.consent.status === "saved"),
    ).toBe(false);
  });

  it("Don't share is saved as off once native confirms it", async () => {
    const h = harness();
    await toStep(h, 3);
    h.props().consent.onDecline?.();
    expect(h.sharing?.commit).toHaveBeenCalledExactlyOnceWith(false);
    await settled();
    expect(h.sharing?.native.stored).toBe(false);
    expect(h.props().consent).toMatchObject({ status: "saved", choice: "off" });
  });

  it("a Don't share that never reached native is a failure with the approved retry, never Saved", async () => {
    const sharing = nativeConsent();
    sharing.native.writesOff = false; // like a permission-gated writer that never writes off
    const h = harness({ sharing });
    await toStep(h, 3);
    h.props().consent.onDecline?.();
    await settled();
    expect(sharing.native.stored).toBeUndefined();
    const consent = h.props().consent;
    expect(consent.status).toBe("failed");
    expect(consent.operation).toMatchObject({
      tone: "failed",
      text: "We couldn't save your choice. Still works either way.",
      actionLabel: "Try again",
    });
    expect(
      h.views.some((v) => v.visible && v.props.consent.status === "saved"),
    ).toBe(false);
    h.props().onContinue?.();
    expect(h.props().step).toBe(3);
    sharing.native.writesOff = true;
    consent.operation?.onAction?.();
    expect(sharing.commit).toHaveBeenLastCalledWith(false);
    await settled();
    expect(h.props().consent).toMatchObject({ status: "saved", choice: "off" });
  });

  it.each([
    ["refused write", (n: ReturnType<typeof nativeConsent>) => (n.native.refuseWrite = true)],
    ["older native reply", (n: ReturnType<typeof nativeConsent>) => (n.native.replyAnswered = false)],
  ])("a %s fails and Share can be retried", async (_label, breakIt) => {
    const sharing = nativeConsent();
    breakIt(sharing);
    const h = harness({ sharing });
    await toStep(h, 3);
    h.props().consent.onShare?.();
    await settled();
    expect(h.props().consent.status).toBe("failed");
    sharing.native.refuseWrite = false;
    sharing.native.replyAnswered = true;
    h.props().consent.operation?.onAction?.();
    await settled();
    expect(h.props().consent).toMatchObject({ status: "saved", choice: "on" });
  });

  it("a commit that never settles fails at the outer deadline", async () => {
    const sharing = nativeConsent();
    const h = harness({ sharing, consentDeadlineMs: 80 });
    await toStep(h, 3);
    vi.useFakeTimers();
    sharing.commit.mockImplementation(() => new Promise(() => {}));
    h.props().consent.onDecline?.();
    await vi.advanceTimersByTimeAsync(80);
    expect(h.props().consent.status).toBe("failed");
  });

  it.each([
    ["purposes are not verified", { purposesVerified: false }],
    ["there are no purposes", { purposes: [] }],
  ] as const)(
    "with a committer but %s, the question is skipped like a build without one",
    async (_label, over) => {
      const h = harness(over);
      await toStep(h, 2);
      h.props().onAssertEnabled?.();
      expect(h.props().step).toBe(4);
      expect(h.views.some((v) => v.visible && v.props.step === 3)).toBe(false);
      const labels = h.views
        .filter((v) => v.visible)
        .map((v) => `${v.props.progress?.current} of ${v.props.progress?.total}`);
      expect([...new Set(labels)]).toEqual(["1 of 3", "2 of 3", "3 of 3"]);
      expect(h.props().consent.onShare).toBeUndefined();
      expect(h.props().consent.onDecline).toBeUndefined();
      expect(h.sharing?.warm).not.toHaveBeenCalled();
      expect(h.sharing?.commit).not.toHaveBeenCalled();
      h.props().onBack?.();
      expect(h.props().step).toBe(2);
    },
  );

  it("a build that cannot record a choice skips the question and never shows Saved", async () => {
    const h = harness({ sharing: null });
    await toStep(h, 2);
    h.props().onAssertEnabled?.();
    expect(h.props().step).toBe(4);
    expect(h.views.some((v) => v.visible && v.props.step === 3)).toBe(false);
    expect(
      h.views.some((v) => v.visible && v.props.consent.status === "saved"),
    ).toBe(false);
    expect(h.props().consent.onShare).toBeUndefined();
    expect(h.props().consent.onDecline).toBeUndefined();
    h.props().onBack?.();
    expect(h.props().step).toBe(2);
  });

  it("a mac build that cannot record a choice also goes from setup to step 4", async () => {
    const h = harness({
      sharing: null,
      state: macState,
      observation: mac("enabled"),
    });
    await toStep(h, 2);
    h.props().onContinue?.();
    expect(h.props().step).toBe(4);
  });
});

describe("step labels follow the actual flow", () => {
  it("counts four steps when consent is asked", async () => {
    const h = harness();
    await h.host.start();
    const seen: string[] = [];
    const label = () => `${h.props().progress?.current} of ${h.props().progress?.total}`;
    seen.push(label());
    await toStep(h, 4);
    for (const view of h.views)
      if (view.visible)
        seen.push(`${view.props.progress?.current} of ${view.props.progress?.total}`);
    expect([...new Set(seen)]).toEqual(["1 of 4", "2 of 4", "3 of 4", "4 of 4"]);
  });

  it("counts three steps without a consent step, never jumping 2 to 4", async () => {
    const h = harness({ sharing: null });
    await toStep(h, 2);
    h.props().onAssertEnabled?.();
    const labels = h.views
      .filter((v) => v.visible)
      .map((v) => `${v.props.progress?.current} of ${v.props.progress?.total}`);
    expect([...new Set(labels)]).toEqual(["1 of 3", "2 of 3", "3 of 3"]);
  });
});

describe("completion", () => {
  it.each([
    ["onOpenSafari", "safari"],
    ["onGoToSettings", "settings"],
  ] as const)(
    "%s completes the native gate once and only then reports done",
    async (port, destination) => {
      const pending = deferred<boolean>();
      const h = harness();
      h.bridge.completeOnboarding.mockReturnValueOnce(pending.promise);
      await toStep(h, 4);
      expect(h.props().step).toBe(4);
      h.props()[port]?.();
      h.props()[port]?.();
      await Promise.resolve();
      expect(h.bridge.completeOnboarding).toHaveBeenCalledOnce();
      const saving = h.host.view;
      expect(saving.visible && saving.completion).toBe("saving");
      expect(h.props().onOpenSafari).toBeUndefined();
      expect(h.props().onGoToSettings).toBeUndefined();
      expect(h.props().onBack).toBeUndefined();
      expect(h.onDone).not.toHaveBeenCalled();
      pending.resolve(true);
      await flush();
      expect(h.host.view).toEqual({ visible: false, done: true });
      expect(h.onDone).toHaveBeenCalledExactlyOnceWith(destination);
    },
  );

  it("a refused completion keeps onboarding visible and lets the user retry", async () => {
    const h = harness({ complete: false });
    await toStep(h, 4);
    h.props().onOpenSafari?.();
    await flush();
    const failed = h.host.view;
    expect(failed.visible && failed.completion).toBe("failed");
    expect(h.props().step).toBe(4);
    expect(h.onDone).not.toHaveBeenCalled();
    h.bridge.completeOnboarding.mockResolvedValueOnce(true);
    h.props().onOpenSafari?.();
    await flush();
    expect(h.bridge.completeOnboarding).toHaveBeenCalledTimes(2);
    expect(h.onDone).toHaveBeenCalledExactlyOnceWith("safari");
  });

  it("a failed completion shows the approved line, and Try again retries the same destination once per tap", async () => {
    const h = harness({ complete: false });
    await toStep(h, 4);
    expect(h.props().completion).toBeUndefined();
    h.props().onGoToSettings?.();
    await flush();
    const line = h.props().completion;
    expect(line).toMatchObject({
      tone: "failed",
      text: "We couldn't finish setup.",
      actionLabel: "Try again",
    });
    const retry = deferred<boolean>();
    h.bridge.completeOnboarding.mockReturnValueOnce(retry.promise);
    line?.onAction?.();
    line?.onAction?.();
    await Promise.resolve();
    expect(h.bridge.completeOnboarding).toHaveBeenCalledTimes(2);
    expect(h.props().completion).toBeUndefined(); // no failure line while retrying
    retry.resolve(true);
    await flush();
    expect(h.onDone).toHaveBeenCalledExactlyOnceWith("settings");
  });

  it("a failure from an earlier attempt is gone when step 4 is entered again", async () => {
    const h = harness({ complete: false });
    await toStep(h, 4);
    h.props().onOpenSafari?.();
    await flush();
    expect(h.props().completion?.text).toBe("We couldn't finish setup.");
    h.props().onBack?.();
    expect(h.props().step).toBe(3);
    h.props().onContinue?.();
    expect(h.props().step).toBe(4);
    expect(h.props().completion).toBeUndefined();
    const view = h.host.view;
    expect(view.visible && view.completion).toBe("idle");
  });

  it("a completion that never answers fails at the deadline instead of hanging", async () => {
    const h = harness();
    await toStep(h, 4);
    vi.useFakeTimers();
    h.bridge.completeOnboarding.mockImplementation(() => new Promise(() => {}));
    h.props().onGoToSettings?.();
    await vi.advanceTimersByTimeAsync(50);
    const view = h.host.view;
    expect(view.visible && view.completion).toBe("failed");
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it("completion is not reachable before step 4", async () => {
    const h = harness();
    await toStep(h, 3);
    h.props().onOpenSafari?.();
    h.props().onGoToSettings?.();
    expect(h.bridge.completeOnboarding).not.toHaveBeenCalled();
  });

  it("dispose drops a late completion", async () => {
    const pending = deferred<boolean>();
    const h = harness();
    h.bridge.completeOnboarding.mockReturnValueOnce(pending.promise);
    await toStep(h, 4);
    h.props().onOpenSafari?.();
    h.host.dispose();
    pending.resolve(true);
    await flush();
    expect(h.onDone).not.toHaveBeenCalled();
  });
});

describe("leaving the app (fixed native destinations)", () => {
  it("the setup button opens each platform's own enable location, from the tap", async () => {
    const m = harness({ state: macState, observation: mac("disabled") });
    await toStep(m, 2);
    m.props().setup?.onOpen?.();
    expect(m.openSetup).toHaveBeenCalledExactlyOnceWith("safariExtensionSettings");
    const i = harness();
    await toStep(i, 2);
    i.props().setup?.onOpen?.();
    expect(i.openSetup).toHaveBeenCalledExactlyOnceWith("settingsAppStillPage");
  });

  it("Open Safari opens Safari only after the native gate confirmed, then reports done", async () => {
    const pending = deferred<boolean>();
    const h = harness({ state: macState, observation: mac("disabled") });
    const order: string[] = [];
    h.openSafari.mockImplementation(() => order.push("open safari"));
    h.onDone.mockImplementation(() => order.push("done"));
    h.bridge.completeOnboarding.mockReturnValueOnce(pending.promise);
    await toStep(h, 4);
    h.props().onOpenSafari?.();
    await Promise.resolve();
    expect(h.openSafari).not.toHaveBeenCalled();
    pending.resolve(true);
    await flush();
    expect(order).toEqual(["open safari", "done"]);
  });

  it("a refused or late completion never opens Safari", async () => {
    const h = harness({ state: macState, observation: mac("disabled"), complete: false });
    await toStep(h, 4);
    h.props().onOpenSafari?.();
    await flush();
    expect(h.openSafari).not.toHaveBeenCalled();
  });

  it("Go to Settings never opens Safari", async () => {
    const h = harness({ state: macState, observation: mac("disabled") });
    await toStep(h, 4);
    h.props().onGoToSettings?.();
    await flush();
    expect(h.onDone).toHaveBeenCalledExactlyOnceWith("settings");
    expect(h.openSafari).not.toHaveBeenCalled();
  });

  it("per-platform destinations: Safari is reachable on macOS and disabled on iOS", async () => {
    const destinations = (platform: "ios" | "mac") =>
      platform === "mac" ? (["safari", "settings"] as const) : (["settings"] as const);
    const m = harness({ state: macState, observation: mac("disabled"), destinations });
    await toStep(m, 4);
    expect(m.props().onOpenSafari).toBeTypeOf("function");
    const i = harness({ destinations });
    await toStep(i, 4);
    expect(i.props().onOpenSafari).toBeUndefined();
    expect(i.props().onGoToSettings).toBeTypeOf("function");
  });

  // #282 review P3-3: the complete() destination guard. Every port step 4 exposes, including the
  // failure line's Try again, is driven; a destination left out must never reach the native gate.
  it.each([
    ["a fixed list", ["settings"] as const],
    ["a per-platform rule", () => ["settings"] as const],
  ])("a destination left out (%s) never completes through any port", async (_name, destinations) => {
    const h = harness({ destinations, complete: false });
    await toStep(h, 4);
    const portsOf = (props: AppleOnboardingProps) =>
      [props.onOpenSafari, props.completion?.onAction, props.onContinue].filter(
        (port): port is () => void => typeof port === "function",
      );
    for (const port of portsOf(h.props())) port();
    await flush();
    expect(h.bridge.completeOnboarding).not.toHaveBeenCalled();
    expect(h.props().onOpenSafari).toBeUndefined();
    // A reachable destination's failure retries itself, never the left-out one.
    h.props().onGoToSettings?.();
    await flush();
    expect(h.props().completion?.text).toBe("We couldn't finish setup.");
    h.bridge.completeOnboarding.mockResolvedValue(true);
    for (const port of portsOf(h.props())) port();
    await flush();
    expect(h.bridge.completeOnboarding).toHaveBeenCalledTimes(2);
    expect(h.onDone).toHaveBeenCalledExactlyOnceWith("settings");
    expect(h.openSafari).not.toHaveBeenCalled();
  });

  // #282 review P3-4: a native reply that arrives after the deadline.
  it("a completion confirmed after the deadline stays failed, opens nothing, and retry still works", async () => {
    vi.useFakeTimers();
    const h = harness({ state: macState, observation: mac("disabled") });
    await h.host.start();
    h.props().onContinue?.();
    await vi.advanceTimersByTimeAsync(0);
    h.props().onDoLater?.();
    h.props().consent.onDecline?.();
    await vi.advanceTimersByTimeAsync(0);
    h.props().onContinue?.();
    expect(h.props().step).toBe(4);
    let confirm!: (ok: boolean) => void;
    h.bridge.completeOnboarding.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        confirm = resolve;
      }),
    );
    h.props().onOpenSafari?.();
    await vi.advanceTimersByTimeAsync(50); // the harness deadline
    const failed = h.host.view;
    expect(failed.visible && failed.completion).toBe("failed");
    confirm(true);
    await vi.advanceTimersByTimeAsync(0);
    const still = h.host.view;
    expect(still.visible && still.completion).toBe("failed");
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.openSafari).not.toHaveBeenCalled();
    h.props().completion?.onAction?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onDone).toHaveBeenCalledExactlyOnceWith("safari");
    expect(h.openSafari).toHaveBeenCalledOnce();
  });
});
