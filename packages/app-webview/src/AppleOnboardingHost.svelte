<script lang="ts">
  // D12 Apple onboarding host: prop plumbing only. Every rule (the one native gate, setup status,
  // completion) lives in @still/core's tested apple-onboarding-host module. The entry reaches this
  // file only through the same build-time-folded dynamic import as the D04 settings host, so the
  // D12 screens and their global stylesheet exist only in bundles that opt in. The leaf is imported
  // by file path through this package's dependency link, as AppleSettingsHost imports its leaf.
  import { untrack } from "svelte";
  import AppleOnboarding from "../node_modules/@still/core/src/ui/v3/AppleOnboarding.svelte";
  import type {
    AppleOnboardingHost,
    AppleOnboardingHostView,
  } from "../node_modules/@still/core/src/ui/v3/apple-onboarding-host.js";

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
  <AppleOnboarding {...view.props} />
{/if}
