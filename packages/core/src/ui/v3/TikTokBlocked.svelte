<script lang="ts">
  import { onDestroy } from "svelte";
  import ConfirmationDialog from "./ConfirmationDialog.svelte";
  import {
    sameTikTokIdentity,
    tikTokSupported,
    tikTokPortReady,
    tikTokReloadConfirmed,
    type TikTokBlockedPresentation,
    type TikTokActionPort,
  } from "./tiktok-blocked-presentation.js";
  import "./design/styles.css";

  let { presentation }: { presentation?: TikTokBlockedPresentation } = $props();
  type Action =
    "requestConfirmation" | "confirmOpen" | "cancel" | "settings" | "reload";
  const actions: readonly Action[] = [
    "requestConfirmation",
    "confirmOpen",
    "cancel",
    "settings",
    "reload",
  ];
  // Preserve the fence when a caller merely republishes the same observation.
  let previous: { values: readonly unknown[] } | undefined;
  let current = $derived.by(() => {
    const p = presentation;
    const values = [
      p?.observation,
      p?.identity.request,
      p?.identity.tab,
      p?.identity.document,
      p?.state,
      p?.verified,
      p?.fresh,
      ...actions.flatMap((action) => [
        p?.[action],
        p?.[action]?.request,
        p?.[action]?.status,
      ]),
    ];
    if (previous && values.every((value, i) => value === previous?.values[i]))
      return previous;
    previous = { values };
    return previous;
  });
  // Fence intent dispatch only; caller observations alone control the screen and modal.
  let requested = $state.raw<typeof current>();
  let cancelRequested = $state.raw<typeof current>();
  let mounted = true;
  onDestroy(() => {
    mounted = false;
  });
  let confirming = $derived(
    presentation?.state === "confirmation" && tikTokSupported(presentation),
  );
  let inertBackground = $state(false);
  let background: HTMLDivElement | undefined = $state();
  $effect.pre(() => {
    // The old dialog restores focus during keyed teardown. Release its opener
    // before that teardown, including a current confirmation-port replacement.
    if (current && background) background.inert = false;
  });
  $effect(() => {
    // Let the maintained dialog capture its opener and move focus before making
    // that opener inert. Releasing inert on close precedes trap teardown.
    const scope = current;
    inertBackground = false;
    if (!confirming) return;
    let active = true;
    queueMicrotask(() => {
      if (!active || !mounted || current !== scope) return;
      const focused = document.activeElement;
      const dialog =
        background?.parentElement?.querySelector('[role="dialog"]');
      // The shared safe-cancel focus intentionally prevents page scrolling.
      // Reveal that real focused control in an overflowing large-text dialog.
      if (focused instanceof HTMLElement && dialog?.contains(focused))
        focused.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      inertBackground = true;
    });
    return () => {
      active = false;
    };
  });
  let reloading = $derived(tikTokReloadConfirmed(presentation));
  let backgroundKey = $derived(
    presentation
      ? `${presentation.observation}\0${presentation.identity.request}\0${presentation.identity.tab}\0${presentation.identity.document}`
      : "",
  );

  function allowed(
    p: TikTokBlockedPresentation | undefined,
    port: TikTokActionPort | undefined,
    action: Action,
  ): boolean {
    if (!tikTokPortReady(p, port)) return false;
    if (action === "settings")
      return p?.host === "browser" && p.state !== "confirmation";
    if (!tikTokSupported(p)) return false;
    if (action === "reload") return tikTokReloadConfirmed(p);
    return (
      p?.state ===
      (action === "requestConfirmation" ? "blocked" : "confirmation")
    );
  }

  function intent(
    p: TikTokBlockedPresentation | undefined,
    port: TikTokActionPort | undefined,
    action: Action,
  ) {
    const scope = current;
    const identity = p ? { ...p.identity } : undefined;
    const observation = p?.observation;
    const request = port?.request;
    return () => {
      if (
        !mounted ||
        current !== scope ||
        !p ||
        presentation !== p ||
        !identity ||
        presentation.observation !== observation ||
        !sameTikTokIdentity(identity, presentation.identity) ||
        presentation[action] !== port ||
        port?.request !== request ||
        !allowed(presentation, port, action)
      )
        return;
      if (action === "cancel") {
        if (cancelRequested === scope) return;
        cancelRequested = scope;
      } else {
        if (requested === scope || cancelRequested === scope) return;
        requested = scope;
      }
      request?.();
    };
  }
</script>

<main class="still-ui blocked">
  <div
    class="still-logo"
    role="img"
    aria-label="Still"
    translate="no"
    inert={confirming && inertBackground}
    style="--logo-mark-size:44px;--logo-word-size:35px"
  >
    <svg class="mark" viewBox="0 0 48 48" aria-hidden="true">
      <rect width="48" height="48" rx="13" fill="var(--still-blue)"></rect>
      <line
        x1="9"
        y1="30"
        x2="39"
        y2="30"
        stroke="#fff"
        stroke-width="2.4"
        stroke-linecap="round"
      ></line>
      <circle cx="24" cy="26.4" r="3.6" fill="#fff"></circle>
    </svg>
  </div>
  <h1 inert={confirming && inertBackground}>TikTok stays closed.</h1>
  <div
    bind:this={background}
    class="blocked-actions"
    inert={confirming && inertBackground}
  >
    {#key backgroundKey}
      {#if reloading}
        <div class="status-line" data-tone="info">
          <div class="status-body">
            <span>Reload this page to open TikTok.</span>
          </div>
        </div>
        {#key presentation?.reload}
          {#key presentation?.reload?.request}
            <button
              type="button"
              class="primary"
              aria-disabled={requested === current ||
                !allowed(presentation, presentation?.reload, "reload") ||
                undefined}
              onclick={intent(presentation, presentation?.reload, "reload")}
              >Reload page</button
            >
          {/key}
        {/key}
      {:else}
        {#key presentation?.requestConfirmation}
          {#key presentation?.requestConfirmation?.request}
            <button
              type="button"
              class="secondary"
              aria-disabled={confirming ||
                requested === current ||
                !allowed(
                  presentation,
                  presentation?.requestConfirmation,
                  "requestConfirmation",
                ) ||
                undefined}
              onclick={confirming
                ? undefined
                : intent(
                    presentation,
                    presentation?.requestConfirmation,
                    "requestConfirmation",
                  )}>Open TikTok this time</button
            >
          {/key}
        {/key}
        {#if presentation?.host === "ios"}
          <p class="manual">
            To change this, open the Still app and turn off TikTok website.
          </p>
        {:else}
          {#key presentation?.settings}
            {#key presentation?.settings?.request}
              <button
                type="button"
                class="link center"
                aria-disabled={confirming ||
                  requested === current ||
                  !allowed(presentation, presentation?.settings, "settings") ||
                  undefined}
                onclick={confirming
                  ? undefined
                  : intent(presentation, presentation?.settings, "settings")}
                >Change this in Still settings</button
              >
            {/key}
          {/key}
        {/if}
      {/if}
    {/key}
  </div>
  {#key current}
    <ConfirmationDialog
      open={confirming}
      title="Open TikTok in this tab?"
      body="TikTok opens in this tab until you close it. Other tabs stay closed, and your setting doesn't change."
      confirmLabel="Open TikTok this time"
      tone="primary"
      cancelLabel="Keep it closed"
      onConfirm={requested !== current &&
      cancelRequested !== current &&
      allowed(presentation, presentation?.confirmOpen, "confirmOpen")
        ? intent(presentation, presentation?.confirmOpen, "confirmOpen")
        : undefined}
      onCancel={intent(presentation, presentation?.cancel, "cancel")}
    />
  {/key}
</main>
