/** Transient UI bindings only. These inputs do not establish native tab authority. */
export interface TikTokBlockedIdentity {
  request: string;
  tab: string;
  document: string;
}

interface TikTokObservationBinding {
  identity: TikTokBlockedIdentity;
  observation: string;
  verified: boolean;
  fresh: boolean;
}

export interface TikTokActionPort extends TikTokObservationBinding {
  status: "ready" | "pending" | "unknown" | "unavailable";
  request?: () => void;
}

export interface TikTokBlockedPresentation extends TikTokObservationBinding {
  host: "browser" | "ios";
  state: "blocked" | "confirmation" | "pending" | "reload";
  capability?: TikTokObservationBinding & {
    status: "supported" | "unknown" | "unavailable";
  };
  requestConfirmation?: TikTokActionPort;
  /**
   * Confirm and cancel are fenced separately, so a cancel can still be
   * dispatched after a confirm in the same observation, before the caller
   * transitions. The caller must arbitrate a cancel that arrives after a
   * confirm; this leaf never resolves that race or grants anything itself.
   */
  confirmOpen?: TikTokActionPort;
  cancel?: TikTokActionPort;
  settings?: TikTokActionPort;
  reload?: TikTokActionPort;
  /** The caller validates and owns the destination. No URL enters this leaf. */
  outcome?: TikTokObservationBinding & {
    status: "granted-reload-needed";
    destinationValidated: boolean;
  };
  /**
   * Owner decision 34: the last "Open TikTok this time" attempt from this page did not finish
   * (a failed or unanswered request, confirm or reopen, or a confirmation the background let go).
   * Display only. Retrying goes through `requestConfirmation`, so it always asks again.
   */
  failure?: TikTokObservationBinding & { status: "open-failed" };
}

export function sameTikTokIdentity(
  left: TikTokBlockedIdentity,
  right: TikTokBlockedIdentity,
): boolean {
  return (
    [left.request, left.tab, left.document].every(
      (value) => value.trim().length > 0,
    ) &&
    left.request === right.request &&
    left.tab === right.tab &&
    left.document === right.document
  );
}

function currentBinding(
  presentation: TikTokBlockedPresentation | undefined,
  binding: TikTokObservationBinding | undefined,
): boolean {
  return !!(
    presentation?.verified &&
    presentation.fresh &&
    presentation.observation.trim() &&
    binding?.verified &&
    binding.fresh &&
    binding.observation === presentation.observation &&
    sameTikTokIdentity(presentation.identity, binding.identity)
  );
}

export function tikTokSupported(
  presentation: TikTokBlockedPresentation | undefined,
): boolean {
  return (
    currentBinding(presentation, presentation?.capability) &&
    presentation?.capability?.status === "supported"
  );
}

export function tikTokPortReady(
  presentation: TikTokBlockedPresentation | undefined,
  port: TikTokActionPort | undefined,
): boolean {
  return (
    currentBinding(presentation, port) &&
    port?.status === "ready" &&
    typeof port.request === "function"
  );
}

export function tikTokReloadConfirmed(
  presentation: TikTokBlockedPresentation | undefined,
): boolean {
  return !!(
    presentation?.state === "reload" &&
    tikTokSupported(presentation) &&
    currentBinding(presentation, presentation.outcome) &&
    presentation.outcome?.status === "granted-reload-needed" &&
    presentation.outcome.destinationValidated
  );
}

/** True while the blocked page should show "Couldn't open TikTok." with its Try again action. */
export function tikTokOpenFailed(
  presentation: TikTokBlockedPresentation | undefined,
): boolean {
  return !!(
    presentation?.state === "blocked" &&
    tikTokSupported(presentation) &&
    currentBinding(presentation, presentation.failure) &&
    presentation.failure?.status === "open-failed"
  );
}
