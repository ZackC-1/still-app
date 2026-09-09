import type { AccountSyncStatus } from "../sync/account-status.js";
import type { UiController } from "./controller.svelte.js";

export type AccountStatusSnapshot = AccountSyncStatus & { extensionMatchesApp?: boolean };

/** Popup-local refresh: no account metadata is exposed to a content script or site. */
export function watchAccountStatus(
  controller: UiController,
  read: () => Promise<AccountStatusSnapshot | null>,
): () => void {
  let stopped = false;
  let pending = false;
  const refresh = async (): Promise<void> => {
    if (stopped || pending || document.visibilityState === "hidden") return;
    pending = true;
    const revision = controller.accountRevision;
    try {
      const status = await read();
      if (stopped || controller.accountRevision !== revision) return;
      controller.userId = status?.accountId ?? null;
      controller.extensionMatchesApp = status?.extensionMatchesApp ?? null;
      controller.accountEmail = status?.email ?? null;
      controller.lastSyncedAt = status?.lastSyncedAt ?? null;
      controller.pendingUpload = status?.pendingUpload ?? false;
      controller.cloudReachable = status?.cloudReachable ?? true;
    } catch {
      // An unavailable background/native read is not a sign-out or a successful sync.
      if (!stopped && controller.accountRevision === revision) controller.cloudReachable = false;
    } finally { pending = false; }
  };
  const request = () => { void refresh(); };
  const timer = setInterval(request, 2_000);
  document.addEventListener("visibilitychange", request);
  request();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", request);

  };

  return stop;
}
