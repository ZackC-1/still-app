import type { ServiceId } from "@still/shared-types";
import type { SettingsCache } from "../../storage/cache.js";
import type { UiController } from "../controller.svelte.js";
import type { CommittedPopupToggle } from "../index.js";

/** The existing factory cache is the only saved-read and command authority. */
export type LegacyPopupAuthority = Pick<
  SettingsCache,
  | "legacyReadState"
  | "subscribeLegacyRead"
  | "rereadLegacyAuthority"
  | "commitLegacyIntent"
>;

export function createLegacyPopupViewBinding(
  getAuthority: () => LegacyPopupAuthority | undefined,
  getController: () => UiController,
  reportCommitted: (toggle: CommittedPopupToggle) => void,
) {
  let observed = $state.raw<LegacyPopupAuthority | null>(null);
  let state = $state.raw<ReturnType<
    LegacyPopupAuthority["legacyReadState"]
  > | null>(null);
  let lifetime = 0;
  type Flight = {
    authority: LegacyPopupAuthority;
    controller: UiController;
    revision: number;
    userId: string | null;
    lifetime: number;
  };
  let failed = $state.raw<Flight | null>(null);
  let recovery = $state.raw<Flight | null>(null);
  function capture(authority: LegacyPopupAuthority): Flight {
    const controller = getController();
    return {
      authority,
      controller,
      revision: controller.accountRevision,
      userId: controller.userId,
      lifetime,
    };
  }
  function current(flight: Flight): boolean {
    const controller = getController();
    return (
      flight.lifetime === lifetime &&
      flight.authority === getAuthority() &&
      flight.authority === observed &&
      flight.controller === controller &&
      flight.revision === controller.accountRevision &&
      flight.userId === controller.userId
    );
  }
  $effect.pre(() => {
    const authority = getAuthority();
    const controller = getController();
    // Account identity changes end view effects, without cancelling admitted writes.
    void controller.userId;
    lifetime += 1;
    observed = authority ?? null;
    state = authority?.legacyReadState() ?? null;
    failed = null;
    recovery = null;
    if (!authority) return;
    const attachment = lifetime;
    const unsubscribe = authority.subscribeLegacyRead(() => {
      if (
        attachment === lifetime &&
        authority === getAuthority() &&
        controller === getController()
      )
        state = authority.legacyReadState();
    });
    return () => {
      lifetime += 1;
      unsubscribe();
      // This view owns its listener only; factory watchers and writes remain alive.
    };
  });
  const held = $derived(
    Boolean(getAuthority()) &&
      (observed !== getAuthority() ||
        (state?.status !== "ready" && state?.status !== "absent") ||
        (failed !== null && current(failed))),
  );
  const unavailable = $derived(
    Boolean(getAuthority()) &&
      observed === getAuthority() &&
      (state?.status === "unavailable" || (failed !== null && current(failed))),
  );
  function recoverSettings(): void {
    const authority = getAuthority();
    if (
      !authority ||
      observed !== authority ||
      !unavailable ||
      (recovery && current(recovery))
    )
      return;
    const flight = capture(authority);
    recovery = flight;
    void authority
      .rereadLegacyAuthority()
      .then((outcome) => {
        if (
          current(flight) &&
          (outcome.status === "ready" || outcome.status === "absent")
        )
          failed = null;
      })
      .catch(() => {
        if (current(flight)) failed = flight;
      })
      .finally(() => {
        if (recovery === flight && current(flight)) recovery = null;
      });
  }
  function toggle(service?: ServiceId): void {
    const authority = getAuthority();
    if (!authority || observed !== authority || held) return;
    // Check current producer readiness at the gesture, never only the rendered snapshot.
    const read = authority.legacyReadState();
    if (read.status !== "ready" && read.status !== "absent") return;
    const choices = read.settings ?? getController().settings;
    if (service && !choices.globalOn) return;
    const enabled = service ? !choices.services[service] : !choices.globalOn;
    const flight = capture(authority);
    void authority
      .commitLegacyIntent(service ? `services.${service}` : "globalOn", enabled)
      .then((outcome) => {
        if (current(flight) && outcome.intentCommitted === true)
          reportCommitted(service ? { service, enabled } : { enabled });
      })
      .catch(() => {
        if (current(flight)) failed = flight;
      });
  }
  return {
    get state() {
      return observed === getAuthority() ? state : null;
    },
    get settings() {
      return observed === getAuthority() ? state?.settings : null;
    },
    get held() {
      return held;
    },
    get settingsUnavailable() {
      return unavailable;
    },
    get recovering() {
      return recovery !== null && current(recovery);
    },
    recoverSettings,
    toggle,
  };
}
