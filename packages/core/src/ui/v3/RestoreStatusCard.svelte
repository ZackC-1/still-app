<script lang="ts">
  import type { RestoreStatusCardProps } from "./extension-settings-presentation.js";
  import Glyph from "./Glyph.svelte";
  // `state` is renamed here: the prop name would shadow the $state rune this card now needs.
  let {
    state: shown,
    onAction,
    nothingCopy,
  }: RestoreStatusCardProps = $props();
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
      detail: undefined,
      action: "Verify now",
    },
  } as const;
  const icons = {
    pending: "spinner",
    success: "check",
    failed: "alert",
    caution: "clock",
  } as const;
  let message = $derived(
    shown === "nothing" && nothingCopy
      ? { ...messages.nothing, ...nothingCopy }
      : messages[shown],
  );

  // ISS-0117: when a check concludes, the result may sit below the visible area (the settings page
  // in its own tab), so "Checking…" seemed to end in nothing. Bring the result into view only if it
  // is not already fully visible ("nearest" also leaves a visible one alone, and an instant scroll
  // follows the page's reduced-motion rule), and move focus to it, never out of a text field or an
  // open dialog. A result shown without a check this visit (a page load) is left alone.
  let line: HTMLDivElement | undefined = $state();
  let previous: RestoreStatusCardProps["state"] | undefined;
  $effect(() => {
    const concluded = previous === "checking" && shown !== "checking";
    previous = shown;
    if (concluded && line) reveal(line);
  });
  function reveal(node: HTMLElement) {
    const box = node.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight)
      node.scrollIntoView?.({ block: "nearest" });
    const active = document.activeElement;
    if (
      active instanceof Element &&
      active.closest(
        'input, textarea, select, [contenteditable="true"], dialog, [role="dialog"]',
      )
    )
      return;
    node.focus({ preventScroll: true });
  }
</script>

<section class="card card-stack">
  <div
    class="status-line"
    bind:this={line}
    tabindex="-1"
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

<style>
  /* Focus lands here only by script (ISS-0117); the card is not a control, so no ring. */
  .status-line:focus {
    outline: none;
  }
</style>
