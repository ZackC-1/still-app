import {
  boundedNativeRead,
  NATIVE_READ_DEADLINE_MS,
  type AnalyticsConsentObservation,
} from "../native/bridge.js";

// The one place the Apple app commits a person's explicit usage-sharing choice ("Share" / "Don't
// share"), shared by the D12 onboarding and the D04 settings card.
//
// It writes straight to the native App Group through the existing `setAnalyticsConsent` writer,
// not through `UiAnalytics.setSharing`: that path is gated on the web analytics permission, so in
// the shipped Apple wiring Share never writes, and with a permission writer wired Don't share never
// reaches native at all. A choice counts as committed only when
//   1. the writer replies that the stored value is the choice and is an explicit answer, AND
//   2. a separate read-back of the native context shows the same value, still answered.
// Sharing reads on until a choice is written, so a value alone can never confirm Share: the unset
// default would. Nothing here turns sharing on by itself.
//
// Web analytics follows the choice through `adopt`: Don't share stops web reporting at the tap,
// before any native round trip and whatever the outcome; Share is adopted only after native
// confirmed it (and records the existing `analytics_choice_made {choice:"share"}`).
//
// Limit (owner decision 21): `answered` means a usage-sharing choice was written at some point. It
// cannot tell an answer to the older 2.1 "Share usage data" switch from an answer to the new
// combined email-plus-usage question. A consumer that links email (D04/U5) must require an explicit
// Share to the NEW question in its own flow before linking, never infer it from `answered`.

/** Above the native first-launch iCloud wait (5 s) that the analytics context read can include. */
export const APPLE_CONSENT_CONFIRM_DEADLINE_MS = 8_000;

export interface AppleConsentBridge {
  commitAnalyticsConsent(enabled: boolean): Promise<boolean>;
  observeAnalyticsConsent(): Promise<AnalyticsConsentObservation | null>;
}

export interface AppleConsentCommitterDeps {
  readonly bridge: AppleConsentBridge;
  /** Keep the web analytics client in line (`AppAnalytics.adoptCommittedConsent`). Called with
   * `false` synchronously at the start of `commit(false)`, whatever happens next; called with
   * `true` only after a confirmed `commit(true)`. */
  readonly adopt?: (enabled: boolean) => void;
  readonly writeDeadlineMs?: number;
  readonly confirmDeadlineMs?: number;
}

export interface AppleConsentCommitter {
  /** Start the native per-launch context read early (a first launch can wait for iCloud), so a
   * later confirmation is fast. Never throws, never writes. */
  warm(): void;
  /** Commit the person's explicit choice. Resolves true only when native confirmed it as an
   * explicit answer; false on any failure, mismatch, timeout or when a newer commit started. */
  commit(enabled: boolean): Promise<boolean>;
}

export function createAppleConsentCommitter(
  deps: AppleConsentCommitterDeps,
): AppleConsentCommitter {
  const writeDeadline = deps.writeDeadlineMs ?? NATIVE_READ_DEADLINE_MS;
  const confirmDeadline =
    deps.confirmDeadlineMs ?? APPLE_CONSENT_CONFIRM_DEADLINE_MS;
  let generation = 0;
  return {
    warm() {
      void boundedNativeRead(
        () => deps.bridge.observeAnalyticsConsent(),
        null,
        confirmDeadline,
      );
    },
    async commit(enabled) {
      const asked = ++generation;
      // Don't share stops web reporting now, before any await.
      if (!enabled) deps.adopt?.(false);
      const written = await boundedNativeRead(
        () => deps.bridge.commitAnalyticsConsent(enabled),
        false,
        writeDeadline,
      );
      if (written !== true || asked !== generation) return false;
      const stored = await boundedNativeRead(
        () => deps.bridge.observeAnalyticsConsent(),
        null,
        confirmDeadline,
      );
      if (asked !== generation) return false;
      if (stored?.answered !== true || stored.consent !== enabled) return false;
      if (enabled) deps.adopt?.(true);
      return true;
    },
  };
}
