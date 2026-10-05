import type { Snippet } from "svelte";
import type { OperationStatus } from "./extension-settings-presentation.js";
import type { OnboardingConsent } from "./apple-onboarding-presentation.js";

/** Actual caller acknowledgement; the same contract as Apple onboarding consent. */
export type FirstRunConsent = OnboardingConsent;

/** Actual supplied host copy; unresolved browser instructions have no defaults. */
export interface FirstRunGuidance {
  verified: boolean;
  text: string;
}

/** Dormant presentation ports. No permission, session, consent or install persistence. */
export interface FirstRunProps {
  browser: "chrome" | "firefox";
  permission: {
    state: "needed" | "pending" | "denied" | "granted" | "unknown";
    verified: boolean;
    requestVerified?: boolean;
    onRequest?: () => void;
    /** TODO: actual approved browser permission wording. */
    guidance?: FirstRunGuidance;
    operation?: OperationStatus;
  };
  blocking: { state: "on" | "off" | "unknown"; verified: boolean };
  /** TODO: actual host setup guidance; permission alone does not prove blocking. */
  setupDescription?: FirstRunGuidance;
  pin: {
    pinned: boolean;
    verified: boolean;
    /** TODO: owner-confirmed browser pinning steps. */
    guidance?: FirstRunGuidance;
  };
  sync: {
    account?: { address: string; confirmed: boolean };
    onSignIn?: () => void;
  };
  /** TODO: actual approved combined purposes/providers and acknowledged storage. */
  consent?: FirstRunConsent;
  /** Existing real privacy actions when no genuine combined-consent producer is supplied. */
  privacyActions?: Snippet;
  /** TODO: verified actual settings/privacy destinations. No invented URLs. */
  settings: { verified: boolean; onOpen?: () => void };
  privacy: { verified: boolean; onOpen?: () => void };
}
