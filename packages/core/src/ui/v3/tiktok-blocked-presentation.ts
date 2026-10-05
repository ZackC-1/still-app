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
  confirmOpen?: TikTokActionPort;
  cancel?: TikTokActionPort;
  settings?: TikTokActionPort;
  reload?: TikTokActionPort;
  /** The caller validates and owns the destination. No URL enters this leaf. */
  outcome?: TikTokObservationBinding & {
    status: "granted-reload-needed";
    destinationValidated: boolean;
  };
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
