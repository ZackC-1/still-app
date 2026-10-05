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
// default would. Nothing here sends an event or turns sharing on by itself.

/** Above the native first-launch iCloud wait (5 s) that the analytics context read can include. */
export const APPLE_CONSENT_CONFIRM_DEADLINE_MS = 8_000;

export interface AppleConsentBridge {
  commitAnalyticsConsent(enabled: boolean): Promise<boolean>;
  observeAnalyticsConsent(): Promise<AnalyticsConsentObservation | null>;
}

export interface AppleConsentCommitterDeps {
  readonly bridge: AppleConsentBridge;
  /** Keep the web analytics client in line after a confirmed commit
   * (`AppAnalytics.adoptCommittedConsent`). Called only on success. */
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
      deps.adopt?.(enabled);
      return true;
    },
  };
}
