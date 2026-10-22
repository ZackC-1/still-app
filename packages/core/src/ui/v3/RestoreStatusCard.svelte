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
  // follows the page's reduced-motion rule) and move keyboard focus to the card. Focus goes to an
  // empty anchor just before the result line, not to the line itself: the line is a live region
  // that already announces the result, so focusing it could announce it twice, and Tab moves on
  // from the anchor through the card. Nothing moves while a text field has focus or a dialog is
  // open; the result simply stays where it is. A result shown without a check this visit (a page
  // load) is left alone.
  let line: HTMLDivElement | undefined = $state();
  let anchor: HTMLSpanElement | undefined = $state();
  let previous: RestoreStatusCardProps["state"] | undefined;
  $effect(() => {
    const concluded = previous === "checking" && shown !== "checking";
    previous = shown;
    if (concluded && line && anchor) reveal(line, anchor);
  });
  function busyElsewhere(): boolean {
    const active = document.activeElement;
    return (
      (active instanceof Element &&
        active.closest(
          'input, textarea, select, [contenteditable="true"], dialog, [role="dialog"]',
        ) !== null) ||
      document.querySelector('dialog[open], [aria-modal="true"]') !== null
    );
  }
  function reveal(result: HTMLElement, focusTarget: HTMLElement) {
    if (busyElsewhere()) return;
    const box = result.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight)
      result.scrollIntoView?.({ block: "nearest" });
    focusTarget.focus({ preventScroll: true });
  }
</script>

<section class="card card-stack restore-card">
  <span class="restore-focus" tabindex="-1" bind:this={anchor}></span>
  <div
    class="status-line"
    bind:this={line}
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
  /* ISS-0117: an empty, script-only focus target with no ring. Out of flow, so the card's flex gap
     and layout are unchanged; it keeps its place in the Tab order. */
  .restore-focus {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
    outline: none;
  }
</style>
