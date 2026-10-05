import type {
  OperationStatus,
  SharingCardProps,
} from "./extension-settings-presentation.js";

/** Actual caller acknowledgement; a requested choice alone is never saved. */
export type OnboardingConsent = Pick<
  SharingCardProps,
  "purposes" | "purposesVerified" | "onShare" | "onDecline"
> &
  (
    | { status: "saved"; choice: "on" | "off"; operation?: OperationStatus }
    | {
        status: "unasked" | "saving" | "failed";
        choice?: "on" | "off";
        operation?: OperationStatus;
      }
  );

export interface AppleOnboardingProps {
  step: 1 | 2 | 3 | 4;
  platform: "ios" | "mac";
  onBack?: () => void;
  onContinue?: () => void;
  /** TODO: approved wording and actual OS destination are supplied by the host. */
  setup?: {
    steps: readonly string[];
    actionLabel: string;
    onOpen?: () => void;
  };
  /** Only trusted macOS host observations can display confirmed enablement. */
  detection?: { state: "waiting" | "on"; verified: boolean };
  /** iOS user assertion, separate from actual native extension confirmation. */
  onAssertEnabled?: () => void;
  onDoLater?: () => void;
  /** TODO: actual approved combined purpose/provider disclosure and saved receipt. */
  consent: OnboardingConsent;
  onOpenSafari?: () => void;
  onGoToSettings?: () => void;
}
