<script lang="ts">
  import { FEATURE_REGISTRY } from "@still/shared-types";
  import ExtensionSettings from "@still/core/ui/v3/ExtensionSettings.svelte";
  import type { ExtensionSettingsProps } from "@still/core/ui/v3/extension-settings-presentation";

  const props: ExtensionSettingsProps = $props();
  // The committed access observation is the only authority. Historical Boolean entitlements
  // and the existence of a navigation destination cannot verify this purchase channel.
  let pro = $derived.by((): ExtensionSettingsProps["pro"] => {
    const states = FEATURE_REGISTRY
      .filter((row) => row.tier === "pro")
      .map((row) => props.access.states[row.id]);
    if (states.some((state) => state === "purchased" || state === "protected"))
      return undefined;
    if (states.includes("verification_required"))
      return { ownership: "verify", channel: "unverified" };
    if (states.includes("checking"))
      return { ownership: "checking", channel: "unverified" };
    return states.includes("locked")
      ? { ownership: "none", channel: "unverified" }
      : undefined;
  });
</script>

<!-- Keep the approved compact card; the existing full purchase view owns the inventory. No
     legacy Restore callback is paid access authority. A scoped producer must supply it later. -->
<ExtensionSettings {...props} {pro} onRestore={undefined} />
