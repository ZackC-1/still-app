import type {
  AppleOnboardingProps,
  OnboardingConsent,
} from "./apple-onboarding-presentation.js";
import type { SharingCardProps } from "./extension-settings-presentation.js";
import {
  APPLE_CONSENT_CONFIRM_DEADLINE_MS,
  type AppleConsentCommitter,
} from "../../analytics/apple-consent.js";
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
//   • Consent changes only from the user's Share / Don't share gesture; nothing here ever turns
//     sharing on by itself. The choice goes through the shared Apple consent committer
//     (analytics/apple-consent.ts), which is "Saved" only when native confirmed it as an explicit
//     answer, never from the on-by-default value. A build that cannot record a choice skips the
//     question (and counts three steps) instead of pretending it was saved.

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
    /** How this host records the choice: the shared `createAppleConsentCommitter`. Absent when
     * the build cannot record one: the consent step is then skipped, never shown as saved. */
    readonly sharing?: Pick<AppleConsentCommitter, "commit"> &
      Partial<Pick<AppleConsentCommitter, "warm">>;
  };
  /** Called once, only after the native gate confirmed completion. */
  readonly onDone: (destination: AppleOnboardingDestination) => void;
  readonly onChange?: (view: AppleOnboardingHostView) => void;
  /** Native read/complete deadline. */
  readonly deadlineMs?: number;
  /** Outer bound on a consent commit (the committer bounds its own steps; this only guarantees
   * the step can never hang on a misbehaving port). */
  readonly consentDeadlineMs?: number;
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

/** Owner-approved failure lines (2026-10-05). */
export const CONSENT_FAILED_TEXT =
  "We couldn't save your choice. Still works either way.";
export const COMPLETION_FAILED_TEXT = "We couldn't finish setup.";
export const RETRY_LABEL = "Try again";

type ConsentState =
  | { status: "unasked" }
  | { status: "saving" | "saved" | "failed"; choice: "on" | "off" };

export function createAppleOnboardingHost(
  deps: AppleOnboardingHostDeps,
): AppleOnboardingHost {
  const deadline = deps.deadlineMs ?? NATIVE_READ_DEADLINE_MS;
  const consentDeadline =
    deps.consentDeadlineMs ??
    NATIVE_READ_DEADLINE_MS + APPLE_CONSENT_CONFIRM_DEADLINE_MS + 1_000;
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
  let consentGeneration = 0;
  let completion: AppleOnboardingCompletion = "idle";
  let lastDestination: AppleOnboardingDestination = "safari";
  const sharing = deps.consent.sharing;
  /** Without a way to record a choice there is no consent step to show. */
  const afterSetup: AppleOnboardingProps["step"] = sharing ? 3 : 4;
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
    if (next !== step) completion = "idle"; // a failure belongs to the attempt it reported
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
    goTo(step === 4 && !sharing ? 2 : ((step - 1) as AppleOnboardingProps["step"]));
  }

  function continueStep(): void {
    if (!active() || busy()) return;
    if (step === 1) goTo(2);
    else if (step === 2 && macOn()) goTo(afterSetup);
    else if (step === 3 && consent.status === "saved") goTo(4);
  }

  function openSetup(): void {
    if (!active() || step !== 2 || macOn() || !deps.openSetup) return;
    setupOpened = true;
    deps.openSetup();
    emit();
  }

  function leaveSetup(): void {
    if (active() && step === 2) goTo(afterSetup);
  }

  function choose(choice: "on" | "off"): void {
    if (!active() || step !== 3 || !sharing) return;
    if (consent.status === "saving" || consent.status === "saved") return;
    if (choice === "on" && !shareOffered()) return;
    const generation = ++consentGeneration;
    consent = { status: "saving", choice };
    emit();
    const settle = (saved: boolean): void => {
      if (disposed || generation !== consentGeneration) return;
      consent = { status: saved ? "saved" : "failed", choice };
      emit();
    };
    let pending: Promise<boolean>;
    try {
      // Called synchronously from the tap.
      pending = sharing.commit(choice === "on");
    } catch {
      settle(false);
      return;
    }
    void boundedNativeRead(() => pending, false, consentDeadline).then((ok) =>
      settle(ok === true),
    );
  }

  function shareOffered(): boolean {
    return (
      !!sharing &&
      deps.consent.purposesVerified === true &&
      !!deps.consent.purposes?.length
    );
  }

  function complete(destination: AppleOnboardingDestination): void {
    if (!active() || step !== 4 || busy()) return;
    lastDestination = destination;
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
      onDecline: sharing ? () => choose("off") : undefined,
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
      operation: {
        tone: "failed",
        text: CONSENT_FAILED_TEXT,
        actionLabel: RETRY_LABEL,
        onAction: () => choose(choice),
      },
    };
  }

  function props(): AppleOnboardingProps {
    const idle = !busy();
    return {
      step,
      progress: sharing
        ? { current: step, total: 4 }
        : { current: step === 4 ? 3 : step, total: 3 },
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
      completion:
        completion === "failed"
          ? {
              tone: "failed",
              text: COMPLETION_FAILED_TEXT,
              actionLabel: RETRY_LABEL,
              onAction: () => complete(lastDestination),
            }
          : undefined,
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
      sharing?.warm?.(); // a first launch's native context read can be slow; start it before step 3
    },
    refreshSetup: readSetup,
    dispose() {
      disposed = true;
      setupGeneration += 1;
    },
  };
}
