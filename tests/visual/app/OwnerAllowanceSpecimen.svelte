<script lang="ts">
  // Private owner layout only. No auth/client, approved-build receipt or server effects are
  // fabricated. Actual local draft edits use OwnerAllowances' controls; callbacks stay inert.
  import OwnerAllowances from "../../../apps/owner-admin/src/OwnerAllowances.svelte";
  import { RATING_OFF } from "../../../apps/owner-admin/src/policy-model.js";
  import "../../../packages/core/src/ui/v3/design/styles.css";
  import { noop } from "./fixtures.js";
  let { stale = false, padding = 12 }: { stale?: boolean; padding?: number } =
    $props();
  const current = $derived({
    ...RATING_OFF,
    master: !stale,
    surfaces: { ...RATING_OFF.surfaces, chrome_desktop: !stale },
  });
</script>

<div style={`padding:${padding}px`}>
  <OwnerAllowances
    {current}
    revision={1}
    phase={stale ? "stale" : "idle"}
    onApply={noop}
    onStatusAction={noop}
  />
</div>
