import type {
  AppleOnboardingProps,
  OnboardingConsent,
} from "./apple-onboarding-presentation.js";
import type { SharingCardProps } from "./extension-settings-presentation.js";
import {
  boundedNativeRead,
  NATIVE_READ_DEADLINE_MS,
  type OnboardingStateReply,
  type SafariSetupObservation,
} from "../../native/bridge.js";

// Host logic for the D12 Apple onboarding (AppleOnboarding.svelte) inside the Apple app's web view.
// Framework-free: it turns native bridge results into the component's props and ports, and reports
// every change through `onChange`. The native OnboardingGate stays the one authority:
//
//   • Visible only when `onboardingState` says `shouldShow: true`. A timeout, a malformed reply or
//     no native host keeps it hidden (the native gate is untouched, so it shows on a later launch).
//   • Setup status comes from `observeSafariSetup` under a deadline. Only a macOS "enabled" is a
//     positive signal; iOS is always "unknown" and never claims the extension is on.
//   • Completion calls `completeOnboarding` once per gesture and reports done only after the native
//     gate confirmed it; a refusal, failure or timeout keeps onboarding visible so the user can retry.
//   • Consent uses the existing usage-sharing switch (`UiAnalytics.setSharing`) and only from the
//     user's Share / Don't share gesture. Nothing here ever turns sharing on by itself.

export interface AppleOnboardingHostBridge {
  onboardingState(): Promise<OnboardingStateReply | null>;
  completeOnboarding(): Promise<boolean>;
  observeSafariSetup(): Promise<SafariSetupObservation | null>;
}

export type AppleOnboardingDestination = "safari" | "settings";

export interface AppleOnboardingHostDeps {
  readonly bridge: AppleOnboardingHostBridge;
  /** Opens the platform's enable location. Absent → the setup button renders disabled. */
  readonly openSetup?: () => void;
  readonly consent: {
    /** Approved combined purposes, supplied by the caller. Share needs them verified. */
    readonly purposes?: SharingCardProps["purposes"];
    readonly purposesVerified: boolean;
    /** The existing usage-sharing switch; resolves to the resulting sharing state. Absent on a
     * build without analytics, where nothing can be shared and only Don't share is offered. */
    readonly setSharing?: (enabled: boolean) => Promise<boolean>;
  };
  /** Called once, only after the native gate confirmed completion. */
  readonly onDone: (destination: AppleOnboardingDestination) => void;
  readonly onChange?: (view: AppleOnboardingHostView) => void;
  readonly deadlineMs?: number;
}

export type AppleOnboardingCompletion = "idle" | "saving" | "failed";

export type AppleOnboardingHostView =
  | { readonly visible: false; readonly done: boolean }
  | {
      readonly visible: true;
      readonly props: AppleOnboardingProps;
      readonly completion: AppleOnboardingCompletion;
    };

export interface AppleOnboardingHost {
  readonly view: AppleOnboardingHostView;
  /** Ask the native gate once whether to show onboarding. */
  start(): Promise<void>;
  /** Re-read Safari setup (e.g. when the app returns to the foreground). No-op off step 2. */
  refreshSetup(): Promise<void>;
  /** Stop applying late results and ignore further gestures. */
  dispose(): void;
}

type Platform = AppleOnboardingProps["platform"];

/** The owner-approved step-2 wording (2026-10-05). iOS 18 moved Safari's settings under Apps. */
export function setupSteps(
  platform: Platform,
  osMajorVersion: number,
): readonly string[] {
  if (platform === "mac")
    return [
      "Open Safari, then Settings, then Extensions.",
      "Turn on Still.",
      "Allow it on every website.",
    ];
  return [
    "Open the Settings app.",
    osMajorVersion >= 18
      ? "Go to Apps, then Safari, then Extensions."
      : "Go to Safari, then Extensions.",
    "Turn on Still and allow it on every website.",
  ];
}

/** The step-2 button, named for where each platform's enable location actually opens. */
export function setupActionLabel(platform: Platform): string {
  return platform === "mac" ? "Open Safari Settings" : "Open Settings";
}

/** Only a trusted macOS "enabled" shows Still as on. "Waiting" is shown only after the user opened
 * the setup location and macOS reported the extension off. iOS never gets a detection. */
export function setupDetection(
  platform: Platform,
  observation: SafariSetupObservation | null,
  setupOpened: boolean,
): AppleOnboardingProps["detection"] {
  if (platform !== "mac" || observation?.platform !== "macos") return undefined;
  if (observation.extensionStatus === "enabled")
    return { state: "on", verified: true };
  if (observation.extensionStatus === "disabled" && setupOpened)
    return { state: "waiting", verified: true };
  return undefined;
}

const CONSENT_FAILED = {
  tone: "failed",
  text: "We couldn't save your choice. Still works either way.",
  actionLabel: "Try again",
} as const;

type ConsentState =
  | { status: "unasked" }
  | { status: "saving" | "saved" | "failed"; choice: "on" | "off" };

export function createAppleOnboardingHost(
  deps: AppleOnboardingHostDeps,
): AppleOnboardingHost {
  const deadline = deps.deadlineMs ?? NATIVE_READ_DEADLINE_MS;
  let started = false;
  let disposed = false;
  let visible = false;
  let done = false;
  let platform: Platform = "ios";
  let osMajorVersion = 0;
  let step: AppleOnboardingProps["step"] = 1;
  let observation: SafariSetupObservation | null = null;
  let setupOpened = false;
  let setupGeneration = 0;
  let consent: ConsentState = { status: "unasked" };
  let completion: AppleOnboardingCompletion = "idle";
  let view: AppleOnboardingHostView = { visible: false, done: false };

  const emit = (): void => {
    view = visible
      ? { visible: true, props: props(), completion }
      : { visible: false, done };
    deps.onChange?.(view);
  };

  const active = (): boolean => !disposed && visible;
  const busy = (): boolean => completion === "saving";
  const macOn = (): boolean =>
    setupDetection(platform, observation, setupOpened)?.state === "on";

  const goTo = (next: AppleOnboardingProps["step"]): void => {
    if (step === 2 && next !== 2) setupGeneration += 1; // a late read can't land on another step
    step = next;
    if (next === 2) {
      observation = null;
      void readSetup();
    }
    emit();
  };

  async function readSetup(): Promise<void> {
    if (!active() || step !== 2) return;
    const generation = ++setupGeneration;
    const result = await boundedNativeRead(
      () => deps.bridge.observeSafariSetup(),
      null,
      deadline,
    );
    if (!active() || step !== 2 || generation !== setupGeneration) return;
    observation = result;
    emit();
  }

  function back(): void {
    if (!active() || busy() || step === 1) return;
    goTo((step - 1) as AppleOnboardingProps["step"]);
  }

  function continueStep(): void {
    if (!active() || busy()) return;
    if (step === 1) goTo(2);
    else if (step === 2 && macOn()) goTo(3);
    else if (step === 3 && consent.status === "saved") goTo(4);
  }

  function openSetup(): void {
    if (!active() || step !== 2 || macOn() || !deps.openSetup) return;
    setupOpened = true;
    deps.openSetup();
    emit();
  }

  function leaveSetup(): void {
    if (active() && step === 2) goTo(3);
  }

  function choose(choice: "on" | "off"): void {
    if (!active() || step !== 3) return;
    if (consent.status === "saving" || consent.status === "saved") return;
    const setSharing = deps.consent.setSharing;
    if (choice === "on" && !shareOffered()) return;
    if (!setSharing) {
      // No analytics in this build: nothing can be shared, so declining is already true.
      consent = { status: "saved", choice: "off" };
      emit();
      return;
    }
    consent = { status: "saving", choice };
    emit();
    const settle = (resulting: unknown): void => {
      if (disposed) return;
      const saved = resulting === (choice === "on");
      consent = { status: saved ? "saved" : "failed", choice };
      emit();
    };
    try {
      // Called synchronously from the tap so a host that must prompt keeps the user gesture.
      setSharing(choice === "on").then(settle, () => settle(undefined));
    } catch {
      settle(undefined);
    }
  }

  function shareOffered(): boolean {
    return (
      !!deps.consent.setSharing &&
      deps.consent.purposesVerified === true &&
      !!deps.consent.purposes?.length
    );
  }

  function complete(destination: AppleOnboardingDestination): void {
    if (!active() || step !== 4 || busy()) return;
    completion = "saving";
    emit();
    void boundedNativeRead(
      () => deps.bridge.completeOnboarding(),
      false,
      deadline,
    ).then((ok) => {
      if (disposed) return;
      if (ok !== true) {
        completion = "failed";
        emit();
        return;
      }
      completion = "idle";
      visible = false;
      done = true;
      emit();
      deps.onDone(destination);
    });
  }

  function consentProps(): OnboardingConsent {
    const base = {
      purposes: deps.consent.purposes,
      purposesVerified: deps.consent.purposesVerified,
      onShare: shareOffered() ? () => choose("on") : undefined,
      onDecline: () => choose("off"),
    };
    if (consent.status === "saved")
      return { ...base, status: "saved", choice: consent.choice };
    if (consent.status === "unasked") return { ...base, status: "unasked" };
    const choice = consent.choice;
    if (consent.status === "saving")
      return { ...base, status: "saving", choice };
    return {
      ...base,
      status: "failed",
      choice,
      operation: { ...CONSENT_FAILED, onAction: () => choose(choice) },
    };
  }

  function props(): AppleOnboardingProps {
    const idle = !busy();
    return {
      step,
      platform,
      onBack: step > 1 && idle ? back : undefined,
      onContinue: idle ? continueStep : undefined,
      setup: {
        steps: setupSteps(platform, osMajorVersion),
        actionLabel: setupActionLabel(platform),
        onOpen: deps.openSetup ? openSetup : undefined,
      },
      detection: setupDetection(platform, observation, setupOpened),
      onAssertEnabled: platform === "ios" ? leaveSetup : undefined,
      onDoLater: platform === "mac" ? leaveSetup : undefined,
      consent: consentProps(),
      onOpenSafari: idle ? () => complete("safari") : undefined,
      onGoToSettings: idle ? () => complete("settings") : undefined,
    };
  }

  return {
    get view() {
      return view;
    },
    async start() {
      if (started || disposed) return;
      started = true;
      const reply = await boundedNativeRead(
        () => deps.bridge.onboardingState(),
        null,
        deadline,
      );
      if (disposed) return;
      if (reply?.ok !== true || reply.shouldShow !== true) {
        emit();
        return;
      }
      platform = reply.platform === "macos" ? "mac" : "ios";
      osMajorVersion = reply.osMajorVersion;
      visible = true;
      step = 1;
      emit();
    },
    refreshSetup: readSetup,
    dispose() {
      disposed = true;
      setupGeneration += 1;
    },
  };
}
