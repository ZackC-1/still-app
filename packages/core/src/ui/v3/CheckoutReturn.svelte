<script lang="ts">
  import type {
    CheckoutReturnAction,
    CheckoutReturnProps,
  } from "./checkout-return-presentation.js";
  import { wordmarkSrc } from "./checkout-return-wordmark.js";
  import Glyph from "./Glyph.svelte";
  import "./design/styles.css";
  import "./checkout-return-layout.css";

  let props: CheckoutReturnProps = $props();
  let current = $derived(
    Boolean(props.requestId.trim()) &&
      props.outcome?.verified &&
      props.outcome.requestId === props.requestId,
  );
  let state: "confirming" | "ready" | "unconfirmed" | "cancelled" = $derived(
    current && props.outcome?.source === "server"
      ? props.outcome.state
      : current && props.outcome?.source === "provider"
        ? "cancelled"
        : "unconfirmed",
  );
  let ready = $derived(state === "ready");
  function available(action: CheckoutReturnAction | undefined) {
    return (
      Boolean(props.requestId.trim()) &&
      action?.requestId === props.requestId &&
      action.verified &&
      Boolean(action.onRequest)
    );
  }
  let canRetry = $derived(
    current &&
      props.outcome?.source === "server" &&
      state === "unconfirmed" &&
      !props.retry?.pending &&
      available(props.retry),
  );
  let canOpen = $derived(ready && available(props.settings));
  const messages = {
    confirming: {
      tone: "pending",
      text: "Confirming your purchase…",
      detail: "This usually takes a few seconds. You can keep this tab open.",
    },
    ready: {
      tone: "success",
      text: "Still Pro is ready.",
      detail:
        "Go back to Still. New blockers start off, so turn on the ones you want.",
    },
    unconfirmed: {
      tone: "failed",
      text: "We couldn't confirm your payment yet.",
      detail:
        "If you were charged, Restore purchase in Still settings will find it.",
    },
    cancelled: {
      tone: "info",
      text: "Checkout was cancelled.",
      detail: "Nothing was bought. You can try again from Still settings.",
    },
  } as const;
  let message = $derived(messages[state]);
  function retry() {
    if (!canRetry) return;
    props.retry?.onRequest?.();
  }
  function settings() {
    if (!canOpen) return;
    props.settings?.onRequest?.();
  }
  function support() {
    if (available(props.support)) props.support?.onRequest?.();
  }
  function privacy() {
    if (available(props.privacy)) props.privacy?.onRequest?.();
  }
</script>

<main class="still-ui fr">
  <div class="fr-col" style="padding-top:64px;">
    <div class="still-logo" role="img" aria-label="Still" translate="no">
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
      <img class="word" src={wordmarkSrc} alt="" />
    </div>
    <h1>{ready ? "Thanks for purchasing Still Pro" : "Still Pro"}</h1>
    <section class="card card-stack">
      <div
        class="status-line"
        data-tone={message.tone}
        role={message.tone === "failed" ? "alert" : "status"}
      >
        {#if message.tone !== "info"}<span class="glyph"
            ><Glyph
              name={message.tone === "pending"
                ? "spinner"
                : message.tone === "success"
                  ? "check"
                  : "alert"}
              size={16}
            /></span
          >{/if}
        <div class="status-body">
          <span>{message.text}</span>
          <span
            class="muted"
            style="font-size:calc(12.5px * var(--text-scale, 1));"
            >{message.detail}</span
          >
          {#if state === "unconfirmed"}<button
              type="button"
              class="link status-action"
              aria-disabled={!canRetry}
              aria-busy={props.retry?.pending || undefined}
              onclick={retry}>Check again</button
            >{/if}
        </div>
      </div>
    </section>
    {#if ready}<button
        type="button"
        class="primary block"
        disabled={!canOpen}
        onclick={settings}>Open Still settings</button
      >{/if}
    <footer class="fr-foot">
      <button
        type="button"
        class="link"
        disabled={!available(props.support)}
        onclick={support}>Contact support</button
      >
      <button
        type="button"
        class="link"
        disabled={!available(props.privacy)}
        onclick={privacy}>Privacy policy</button
      >
    </footer>
  </div>
</main>
