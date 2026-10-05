import { mount, unmount } from "svelte";
import type { NativeBridge } from "@still/core/native";
import { runAppleOnboardingFirst } from "../node_modules/@still/core/src/ui/v3/apple-onboarding-host.js";
import AppleOnboardingHost from "./AppleOnboardingHost.svelte";

// D12 onboarding wiring for the Apple app's web view. Reached only through main.ts's D04 branch,
// a dynamic import that every default build folds away.
//
// The native OnboardingGate is the one authority: its `onboardingState` reply says `shouldShow:
// true` only when the app's Info.plist hands onboarding to the web view and the gate is not yet
// complete. Every other answer (the SwiftUI presenter, a completed gate, no host, a timeout) mounts
// settings straight away, so the two presenters can never both show.
//
// What this build deliberately does not wire:
//   • Consent: no committer and no approved purposes are passed, so the D12 consent question is
//     skipped (three steps) until a real permission producer exists. Nothing is ever shared from
//     here.
//   • Native "open" actions: the bridge has no message that opens the Safari enable location or
//     Safari itself, so "Open Settings" / "Open Safari Settings" and "Open Safari" render disabled.
//     The person continues with "I've turned it on" (iOS) or "Do this later" (macOS), and finishes
//     with "Go to Settings".

export interface AppleOnboardingWiring {
  readonly bridge: Pick<NativeBridge, "onboardingState" | "completeOnboarding" | "observeSafariSetup">;
  readonly target: HTMLElement;
  /** Mounts the settings screen into the same target. Called at most once. */
  readonly showSettings: () => void;
}

export function showAppleOnboardingFirst(
  wiring: AppleOnboardingWiring,
): Promise<"onboarding" | "settings"> {
  const { bridge } = wiring;
  return runAppleOnboardingFirst(
    {
      bridge: {
        onboardingState: () => bridge.onboardingState(),
        completeOnboarding: () => bridge.completeOnboarding(),
        observeSafariSetup: () => bridge.observeSafariSetup(),
      },
      consent: { purposesVerified: false },
      destinations: ["settings"],
    },
    {
      showOnboarding(host, watch) {
        const component = mount(AppleOnboardingHost, {
          target: wiring.target,
          props: { host, watch },
        });
        return () => void unmount(component);
      },
      showSettings: wiring.showSettings,
    },
  );
}
