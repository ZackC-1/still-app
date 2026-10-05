<script lang="ts">
  import type { RestoreStatusCardProps } from "./extension-settings-presentation.js";
  import Glyph from "./Glyph.svelte";
  let { state, onAction }: RestoreStatusCardProps = $props();
  const messages = {
    checking: {
      tone: "pending",
      text: "Checking for Still Pro purchases…",
      detail: undefined,
      action: undefined,
    },
    restored: {
      tone: "success",
      text: "Still Pro is restored on this device.",
      detail: undefined,
      action: undefined,
    },
    nothing: {
      tone: "info",
      text: "No Still Pro purchase was found for this account.",
      detail:
        "Bought it with another account or Apple ID? Sign in with that one and try again.",
      action: undefined,
    },
    failed: {
      tone: "failed",
      text: "We couldn't finish checking. Nothing changed.",
      detail: "Your free controls and saved choices are unaffected.",
      action: "Try again",
    },
    verify: {
      tone: "caution",
      text: "Still Pro needs to be verified again.",
      detail:
        "Go online and sign in. Free controls and your saved choices stay.",
      action: "Verify now",
    },
  } as const;
  const icons = {
    pending: "spinner",
    success: "check",
    failed: "alert",
    caution: "clock",
  } as const;
  let message = $derived(messages[state]);
</script>

<section class="card card-stack">
  <div
    class="status-line"
    data-tone={message.tone}
    role={message.tone === "failed" ? "alert" : "status"}
  >
    {#if message.tone !== "info"}<span class="glyph"
        ><Glyph name={icons[message.tone]} size={16} /></span
      >{/if}
    <div class="status-body">
      <span>{message.text}</span>
      {#if message.detail}<span
          class="muted"
          style="font-size:calc(12.5px * var(--text-scale, 1));"
          >{message.detail}</span
        >{/if}
      {#if message.action}<button
          type="button"
          class="link status-action"
          disabled={!onAction}
          onclick={onAction}>{message.action}</button
        >{/if}
    </div>
  </div>
</section>
