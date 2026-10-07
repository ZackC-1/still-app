<script lang="ts">
  // D12 Apple onboarding host: prop plumbing only. Every rule (the one native gate, setup status,
  // completion) lives in @still/core's tested apple-onboarding-host module. The entry reaches this
  // file only through the same build-time-folded dynamic import as the D04 settings host, so the
  // D12 screens and their global stylesheet exist only in bundles that opt in. The dedicated
  // @still/core export keeps the dependency outside this package's rootDir: src.
  import { untrack } from "svelte";
  import AppleOnboarding from "@still/core/ui/v3/AppleOnboarding.svelte";
  import type {
    AppleOnboardingHost,
    AppleOnboardingHostView,
  } from "@still/core/ui/v3/apple-onboarding-host";

  interface Props {
    /** A started host whose view is visible (runAppleOnboardingFirst mounts only then). */
    host: AppleOnboardingHost;
    /** Every later view change; returns its unsubscribe. */
    watch: (listener: (view: AppleOnboardingHostView) => void) => () => void;
  }
  let { host, watch }: Props = $props();

  let view = $state.raw<AppleOnboardingHostView>(untrack(() => host.view));
  $effect(() =>
    watch((next) => {
      view = next;
    }),
  );
  // Coming back from Safari or the Settings app re-reads the setup state (a no-op off step 2).
  // macOS can leave the window visible while another app is active, so focus counts as well.
  $effect(() => {
    const current = host;
    const refresh = (): void => {
      if (document.visibilityState === "visible") void current.refreshSetup();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  });
</script>

{#if view.visible}
  <div class="onboarding-viewport">
    <AppleOnboarding {...view.props} />
  </div>
{/if}

<style>
  /* D12 is a full-screen layout: the step's content centred, Continue anchored at the bottom.
     AppleOnboarding gets that from `.ob { min-height: 100% }`, which only works inside a box of
     definite height (as in the design's device frame). In the app the chain above it is
     html > body > #app, and the shared rule `html, body, #app { min-block-size: 100% }` gives body
     and #app no definite height, so the percentage resolved to nothing and the whole step sat at
     the top. This host is the only place D12 fills a whole web view, so it supplies the screen
     height here, in a file only opted-in builds contain, rather than in the shared stylesheet
     every shipped screen uses. A web view always has a real viewport; this is never a popup. */
  .onboarding-viewport {
    display: flex;
    flex-direction: column;
    min-block-size: 100vh;
    min-block-size: 100dvh;
  }
  .onboarding-viewport > :global(.ob) {
    flex: 1 0 auto;
  }
</style>
