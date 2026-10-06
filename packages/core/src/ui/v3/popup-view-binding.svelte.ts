import type { FeatureId, ServiceId } from "@still/shared-types";
import type { CommittedPopupBinding, CommittedPopupToggle } from "../index.js";
import type {
  DesktopPopupBindingState,
  DesktopPopupCommandOutcome,
} from "./desktop-popup-binding.js";

/** How long a view waits for the first settings read before calling it unavailable. */
export const FIRST_READ_BOUND_MS = 8_000;

/** One App-owned observation and command lifetime; the binding remains the authority. */
export function createPopupViewBinding(
  getBinding: () => CommittedPopupBinding | undefined,
  reportCommitted: (toggle: CommittedPopupToggle) => void,
) {
  let observedBinding = $state.raw<CommittedPopupBinding | null>(null);
  let popupState = $state.raw<DesktopPopupBindingState | null>(null);
  let popupLifetime = 0;
  let popupCommandTicket = 0;
  // Until the first settings read answers (or the bound passes), an unavailable state is the
  // cache's startup defaults, not a failure: the view says "checking", never "unavailable".
  let reading = $state(true);
  let settingsRecovery = $state.raw<{
    binding: CommittedPopupBinding;
    lifetime: number;
  } | null>(null);
  $effect(() => {
    const binding = getBinding();
    if (!binding) return;
    popupLifetime += 1;
    observedBinding = binding;
    const initial = binding.current();
    popupState = initial;
    settingsRecovery = null;
    let live = true;
    const answered = () => {
      if (live) reading = false;
    };
    // Read the local value, never popupState: this effect must not track its own publications.
    reading = !binding.hasSettled() && initial.commandAvailability !== "ready";
    const bound = setTimeout(answered, FIRST_READ_BOUND_MS);
    void binding.settled.then(answered);
    const unsubscribe = binding.subscribe((state) => {
      popupState = state;
      if (state.commandAvailability === "ready") answered();
    });
    return () => {
      live = false;
      clearTimeout(bound);
      popupLifetime += 1;
      settingsRecovery = null;
      unsubscribe();
      binding.stop();
    };
  });
  function isCurrent(
    binding: CommittedPopupBinding,
    lifetime: number,
  ): boolean {
    return (
      lifetime === popupLifetime &&
      binding === getBinding() &&
      binding === observedBinding &&
      binding.current().reason !== "stopped"
    );
  }
  const held = $derived(
    Boolean(getBinding()) &&
      (observedBinding !== getBinding() ||
        popupState?.commandAvailability !== "ready"),
  );
  const settingsUnavailable = $derived(
    Boolean(getBinding()) &&
      observedBinding === getBinding() &&
      !reading &&
      popupState?.commandAvailability === "unavailable" &&
      getBinding()?.current().reason !== "stopped",
  );
  function recoverSettings(): void {
    const binding = getBinding();
    if (!binding || !settingsUnavailable || settingsRecovery) return;
    const state = binding.current();
    if (
      state.commandAvailability !== "unavailable" ||
      state.reason === "stopped"
    )
      return;
    const flight = { binding, lifetime: popupLifetime };
    settingsRecovery = flight;
    void binding
      .rereadAuthority()
      .catch(() => {
        /* The current cache retains the authoritative hold; never replay an intent. */
      })
      .finally(() => {
        if (settingsRecovery === flight && isCurrent(binding, flight.lifetime))
          settingsRecovery = null;
      });
  }
  function currentPopup(binding: CommittedPopupBinding) {
    if (binding !== getBinding() || binding !== observedBinding) return null;
    const state = binding.current();
    return state.commandAvailability === "ready" && state.settings
      ? state
      : null;
  }
  function runPopupCommand(
    binding: CommittedPopupBinding,
    submit: () => Promise<DesktopPopupCommandOutcome>,
    toggle?: CommittedPopupToggle,
  ): void {
    const lifetime = popupLifetime;
    const ticket = ++popupCommandTicket;
    const current = () => isCurrent(binding, lifetime);
    function reread(reason?: string): void {
      if (!current() || ticket !== popupCommandTicket) return;
      const state = binding.current();
      if (
        reason !== undefined &&
        (state.commandAvailability !== "unavailable" || state.reason !== reason)
      )
        return;
      // A failed deliberate action permits one read, never a retry of its intent.
      void binding.rereadAuthority().catch(() => {
        /* The maintained cache retains the authoritative recovery hold. */
      });
    }
    void submit()
      .then((outcome) => {
        if (!current()) return;
        if (outcome.status === "committed") {
          // A newer deliberate command does not erase an earlier real commit receipt.
          if (toggle) reportCommitted(toggle);
        } else if (outcome.status === "unavailable") reread(outcome.reason);
      })
      .catch(() => reread());
  }
  function popupCommands(binding: CommittedPopupBinding) {
    return {
      global: (enabled: boolean) => {
        if (!currentPopup(binding)) return;
        runPopupCommand(binding, () => binding.setGlobalOn(enabled), {
          enabled,
        });
      },
      service: (service: ServiceId, enabled: boolean) => {
        const state = currentPopup(binding);
        if (!state?.settings?.globalOn) return;
        runPopupCommand(binding, () => binding.setService(service, enabled), {
          service,
          enabled,
        });
      },
      feature: (feature: FeatureId, enabled: boolean) => {
        if (!currentPopup(binding)) return;
        runPopupCommand(binding, () => binding.setFeature(feature, enabled));
      },
    };
  }
  const commands = $derived.by(() => {
    const binding = getBinding();
    return binding ? popupCommands(binding) : null;
  });
  return {
    get state() {
      return popupState;
    },
    get settings() {
      return observedBinding === getBinding() ? popupState?.settings : null;
    },
    get held() {
      return held;
    },
    get settingsUnavailable() {
      return settingsUnavailable;
    },
    /** True until the first settings read answers or the bound passes. */
    get reading() {
      return (
        Boolean(getBinding()) && observedBinding === getBinding() && reading
      );
    },
    get recovering() {
      return Boolean(settingsRecovery);
    },
    get commands() {
      return commands;
    },
    recoverSettings,
    runPopupCommand,
  };
}
