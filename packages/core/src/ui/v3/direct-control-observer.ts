// Counts the person's own successful settings changes toward the sync invitation milestone (U13-P2).
//
// This wraps a committed popup binding from outside so the binding itself is untouched. The
// binding already reports `committed` only when the storage writer's `intentCommitted` was true,
// so a failed, refused, rejected or unchanged request never reaches `report`. Changes that arrive
// from sync or any other source never pass through these commands, so they cannot count either.
// Hosts that must not count (the first-run page) simply do not wrap their binding.

import type { FeatureId, ServiceId } from "@still/shared-types";
import type { InvitationControl } from "../../invitations/ledger.js";
import type { DesktopPopupCommandOutcome } from "./desktop-popup-binding.js";

export interface DirectControlSurface {
  setGlobalOn(value: boolean): Promise<DesktopPopupCommandOutcome>;
  setService(service: ServiceId, value: boolean): Promise<DesktopPopupCommandOutcome>;
  setFeature(feature: FeatureId, value: boolean): Promise<DesktopPopupCommandOutcome>;
}

export function observeDirectControls<B extends DirectControlSurface>(
  binding: B,
  report: (control: InvitationControl) => void,
): B {
  const observe = async (
    control: InvitationControl,
    run: () => Promise<DesktopPopupCommandOutcome>,
  ): Promise<DesktopPopupCommandOutcome> => {
    const outcome = await run();
    if (outcome.status === "committed") {
      try {
        report(control);
      } catch {
        /* Counting never changes a saved outcome. */
      }
    }
    return outcome;
  };
  return {
    ...binding,
    setGlobalOn: (value: boolean) => observe("global", () => binding.setGlobalOn(value)),
    setService: (service: ServiceId, value: boolean) => observe("site", () => binding.setService(service, value)),
    setFeature: (feature: FeatureId, value: boolean) => observe("feature", () => binding.setFeature(feature, value)),
  };
}
