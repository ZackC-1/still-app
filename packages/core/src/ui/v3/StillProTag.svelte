<script lang="ts">
  import { STRINGS } from "../strings.js";
  import type { StillProTagKind } from "./presentation.js";
  // Presentation only. The host decides when to render it and whose Still Pro it is.
  let { kind }: { kind: StillProTagKind } = $props();
</script>

<!-- ISS-0073: the one signal that this person has Still Pro once the popups drop the Still Pro
  card. The same boxed tag as the settings card's "Purchased", as plain text so it is read with
  the account row. Hosts render it only while proPurchased(access) is true. ISS-0105: "Still Pro
  User" only for the signed-in account's own Still Pro, otherwise "Still Pro on this device". -->
<!-- Owner canvas (P-AppSync, P-PopupSync): "Still Pro User" is green; "Still Pro on this device" is
  the neutral boxed tag (secondary ink, strong border). -->
<span class="access-tag boxed still-pro-tag" class:success={kind === "account"}
  >{STRINGS.proTag[kind]}</span
>
