import { mount, unmount } from "svelte";
import { openNativeDestination, type NativeBridge } from "@still/core/native";
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
// Native "open" actions go through the fixed-destination `openDestination` message, from a tap:
//   • "Open Settings" (iOS) opens Still's page in the Settings app; "Open Safari Settings" (macOS)
//     opens Safari's Extensions settings.
//   • "Open Safari" opens Safari on macOS, after the gate confirmed completion. iOS has no public
//     way to open Safari itself, so the button stays disabled there and the person finishes with
//     "Go to Settings".
//
// What this build deliberately does not wire: consent. No committer and no approved purposes are
// passed, so the D12 consent question is skipped (three steps) until a real permission producer
// exists. Nothing is ever shared from here.

/** Present in a web bundle only when this module is. The native presenter switch hands onboarding
 * to the web view only when the bundled web UI contains it (OnboardingGate.webD12Marker), so an
 * app with a legacy web build keeps its SwiftUI onboarding. */
export const D12_WEB_ONBOARDING_MARKER = "still-onboarding-presenter:web-d12";

export interface AppleOnboardingWiring {
  readonly bridge: Pick<NativeBridge, "onboardingState" | "completeOnboarding" | "observeSafariSetup">;
  readonly target: HTMLElement;
  /** Mounts the settings screen into the same target. Called at most once. */
  readonly showSettings: () => void;
  /** Opens a fixed native destination (default: the real `openDestination` message). */
  readonly open?: typeof openNativeDestination;
}

export function showAppleOnboardingFirst(
  wiring: AppleOnboardingWiring,
): Promise<"onboarding" | "settings"> {
  const { bridge } = wiring;
  const open = wiring.open ?? openNativeDestination;
  wiring.target.setAttribute("data-still-onboarding", D12_WEB_ONBOARDING_MARKER);
  return runAppleOnboardingFirst(
    {
      bridge: {
        onboardingState: () => bridge.onboardingState(),
        completeOnboarding: () => bridge.completeOnboarding(),
        observeSafariSetup: () => bridge.observeSafariSetup(),
      },
      consent: { purposesVerified: false },
      openSetup: (location) => void open(location),
      openSafari: () => void open("safari"),
      destinations: (platform) => (platform === "mac" ? ["safari", "settings"] : ["settings"]),
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
