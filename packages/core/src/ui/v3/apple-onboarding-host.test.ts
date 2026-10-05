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

/** A real-shaped native consent store: Apple sharing starts ON, and like
 * `UiAnalytics.setSharing` the switch resolves false for every "Don't share", whether or not the
 * native write actually happened. `commits: false` models a write that silently did not land. */
function nativeConsent(initial = true) {
  const store = { consent: initial, commits: true };
  const set = vi.fn(async (enabled: boolean): Promise<unknown> => {
    if (store.commits) store.consent = enabled;
    return enabled ? store.consent : false;
  });
  const readCommitted = vi.fn(
    async (): Promise<boolean | null> => store.consent,
  );
  return { store, set, readCommitted };
}

function harness(
  options: {
    state?: OnboardingStateReply | null;
    observation?: SafariSetupObservation | null;
    complete?: boolean;
    sharing?: ReturnType<typeof nativeConsent> | null;
    purposesVerified?: boolean;
    openSetup?: boolean;
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
  const views: AppleOnboardingHostView[] = [];
  const consent: AppleOnboardingHostDeps["consent"] = {
    purposes,
    purposesVerified: options.purposesVerified ?? true,
    sharing: sharing && { set: sharing.set, readCommitted: sharing.readCommitted },
  };
  const host = createAppleOnboardingHost({
    bridge,
    openSetup: options.openSetup === false ? undefined : openSetup,
    consent,
    onDone,
    onChange: (view) => views.push(view),
    deadlineMs: 50,
  });
  const props = (): AppleOnboardingProps => {
    const view = host.view;
    if (!view.visible) throw new Error("onboarding is hidden");
    return view.props;
  };
  return { bridge, sharing, onDone, openSetup, views, host, props };
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
  if (step === 3 || !h.sharing) return;
  h.props().consent.onDecline?.();
  await flush();
  await flush();
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
    expect(h.openSetup).toHaveBeenCalledOnce();
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

describe("consent never shares on its own", () => {
  it("walking the whole flow without a choice never touches the switch", async () => {
    const h = harness();
    await toStep(h, 3);
    h.props().onContinue?.();
    expect(h.props().step).toBe(3);
    expect(h.props().consent.status).toBe("unasked");
    expect(h.sharing?.set).not.toHaveBeenCalled();
  });

  it("Share calls the switch once and is saved only after the native consent reads back on", async () => {
    const sharing = nativeConsent(false);
    const h = harness({ sharing });
    await toStep(h, 3);
    h.props().consent.onShare?.();
    h.props().consent.onShare?.();
    expect(sharing.set).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.props().consent.status).toBe("saving");
    await flush();
    await flush();
    expect(sharing.readCommitted).toHaveBeenCalledOnce();
    expect(h.props().consent).toMatchObject({ status: "saved", choice: "on" });
    h.props().onContinue?.();
    expect(h.props().step).toBe(4);
  });

  it("Don't share is saved as off once the native consent reads back off", async () => {
    const sharing = nativeConsent(true);
    const h = harness({ sharing });
    await toStep(h, 3);
    h.props().consent.onDecline?.();
    expect(sharing.set).toHaveBeenCalledExactlyOnceWith(false);
    await flush();
    await flush();
    expect(sharing.store.consent).toBe(false);
    expect(h.props().consent).toMatchObject({ status: "saved", choice: "off" });
  });

  it("a Don't share that left native sharing on is a failure, never Saved", async () => {
    const sharing = nativeConsent(true);
    sharing.store.commits = false; // set(false) still resolves false, like UiAnalytics.setSharing
    const h = harness({ sharing });
    await toStep(h, 3);
    h.props().consent.onDecline?.();
    await flush();
    await flush();
    expect(await sharing.set.mock.results[0]!.value).toBe(false);
    expect(sharing.store.consent).toBe(true);
    const consent = h.props().consent;
    expect(consent.status).toBe("failed");
    expect(h.views.some((v) => v.visible && v.props.consent.status === "saved")).toBe(false);
    h.props().onContinue?.();
    expect(h.props().step).toBe(3);
    // Retry the same choice; once the write lands the read-back confirms it.
    sharing.store.commits = true;
    consent.operation?.onAction?.();
    expect(sharing.set).toHaveBeenLastCalledWith(false);
    await flush();
    await flush();
    expect(h.props().consent).toMatchObject({ status: "saved", choice: "off" });
  });

  it.each([
    ["unreadable", async () => null],
    ["rejected", async () => Promise.reject(new Error("x"))],
  ])("a %s read-back is a failure", async (_label, impl) => {
    const sharing = nativeConsent(true);
    sharing.readCommitted.mockImplementation(impl);
    const h = harness({ sharing });
    await toStep(h, 3);
    h.props().consent.onDecline?.();
    await flush();
    await flush();
    expect(h.props().consent.status).toBe("failed");
  });

  it("a read-back that never answers fails at the deadline", async () => {
    const sharing = nativeConsent(true);
    const h = harness({ sharing });
    await toStep(h, 3);
    vi.useFakeTimers();
    sharing.readCommitted.mockImplementation(() => new Promise(() => {}));
    h.props().consent.onDecline?.();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.props().consent.status).toBe("failed");
  });

  it("a switch that never answers fails at the deadline without a read-back", async () => {
    const sharing = nativeConsent(true);
    const h = harness({ sharing });
    await toStep(h, 3);
    vi.useFakeTimers();
    sharing.set.mockImplementation(() => new Promise(() => {}));
    h.props().consent.onDecline?.();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.props().consent.status).toBe("failed");
    expect(sharing.readCommitted).not.toHaveBeenCalled();
  });

  it.each([
    ["declined by the host", false],
    ["rejected", "reject"],
  ] as const)(
    "a share %s shows the approved failure line with a retry and stays on step 3",
    async (_label, outcome) => {
      const sharing = nativeConsent(false);
      sharing.store.commits = false;
      if (outcome === "reject")
        sharing.set.mockRejectedValueOnce(new Error("x"));
      const h = harness({ sharing });
      await toStep(h, 3);
      h.props().consent.onShare?.();
      await flush();
      await flush();
      const consent = h.props().consent;
      expect(consent.status).toBe("failed");
      expect(consent.operation).toMatchObject({
        tone: "failed",
        text: "We couldn't save your choice. Still works either way.",
        actionLabel: "Try again",
      });
      h.props().onContinue?.();
      expect(h.props().step).toBe(3);
      sharing.store.commits = true;
      consent.operation?.onAction?.();
      expect(sharing.set).toHaveBeenLastCalledWith(true);
      await flush();
      await flush();
      expect(h.props().consent).toMatchObject({ status: "saved", choice: "on" });
    },
  );

  it("Share is not offered without verified purposes", async () => {
    const h = harness({ purposesVerified: false });
    await toStep(h, 3);
    expect(h.props().consent.onShare).toBeUndefined();
  });

  it("a build that cannot record a choice skips the question and never shows Saved", async () => {
    const h = harness({ sharing: null });
    await toStep(h, 2);
    h.props().onAssertEnabled?.();
    expect(h.props().step).toBe(4);
    expect(h.views.some((v) => v.visible && v.props.step === 3)).toBe(false);
    expect(h.views.some((v) => v.visible && v.props.consent.status === "saved")).toBe(false);
    expect(h.props().consent.onShare).toBeUndefined();
    expect(h.props().consent.onDecline).toBeUndefined();
    h.props().onBack?.();
    expect(h.props().step).toBe(2);
  });

  it("a mac build that cannot record a choice also goes from setup to step 4", async () => {
    const h = harness({ sharing: null, state: macState, observation: mac("enabled") });
    await toStep(h, 2);
    h.props().onContinue?.();
    expect(h.props().step).toBe(4);
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
