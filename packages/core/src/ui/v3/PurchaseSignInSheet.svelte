<script lang="ts">
  import { untrack } from "svelte";
  import { trapFocus } from "../focus-trap.js";
  import PurchaseView from "./PurchaseView.svelte";
  import type {
    PurchaseSignInOperation,
    PurchaseSignInPort,
    PurchaseSignInSheetProps,
    PurchaseSignInValueIntent,
  } from "./purchase-signin-presentation.js";
  import "./design/styles.css";

  let props: PurchaseSignInSheetProps = $props();
  const id = $props.id();
  let sheet: HTMLElement | undefined = $state();
  let input: HTMLInputElement | undefined = $state();
  const focusable = "input:not(:disabled), button:not(:disabled)";
  function matches(operation: PurchaseSignInOperation) {
    return (
      props.open &&
      Boolean(
        props.operation.requestId.trim() && props.operation.ownerId.trim(),
      ) &&
      operation.requestId === props.operation.requestId &&
      operation.ownerId === props.operation.ownerId &&
      operation.purpose === props.operation.purpose
    );
  }
  function available<T>(port: PurchaseSignInPort<T> | undefined) {
    return Boolean(port?.verified && matches(port.operation) && port.onRequest);
  }
  let current = $derived(
    props.observation?.verified && matches(props.observation.operation),
  );
  let operationState = $derived(current ? props.observation?.state : "unknown");
  let field = $derived(
    operationState === "code" || operationState === "verifying"
      ? "code"
      : operationState === "failed"
        ? props.observation?.field
        : operationState === "email" || operationState === "sending"
          ? "email"
          : undefined,
  );
  let ready = $derived(
    operationState === "email" ||
      operationState === "code" ||
      operationState === "failed",
  );
  let pending = $derived(
    operationState === "sending" || operationState === "verifying",
  );
  let confirmed = $derived(
    operationState === "confirmed" &&
      props.observation?.account?.confirmed &&
      Boolean(props.observation.account.id.trim()),
  );
  let editable = $derived(
    ready && available(field === "code" ? props.codeInput : props.emailInput),
  );
  let canSubmit = $derived(
    ready &&
      Boolean(field) &&
      available(field === "code" ? props.verify : props.send),
  );
  let background = $derived({
    ...props.background,
    onBack: undefined,
    onSignIn: undefined,
    checkout: { verified: props.background.checkout.verified },
    restorePort: { verified: props.background.restorePort.verified },
    restore: props.background.restore
      ? { ...props.background.restore, onAction: undefined }
      : undefined,
  });
  function edit(event: Event) {
    if (!editable) return;
    const value = (event.currentTarget as HTMLInputElement).value;
    const port = field === "code" ? props.codeInput : props.emailInput;
    if (available(port))
      port?.onRequest?.({
        operation: { ...props.operation },
        value: field === "code" ? value.replace(/\D/g, "").slice(0, 6) : value,
      });
    // DOM text remains controlled even when a caller holds or rejects an intent.
    (event.currentTarget as HTMLInputElement).value =
      field === "code" ? props.code : props.email;
  }
  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    if (
      field === "code"
        ? !/^\d{6}$/.test(props.code)
        : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(props.email)
    )
      return;
    const port: PurchaseSignInPort<PurchaseSignInValueIntent> | undefined =
      field === "code" ? props.verify : props.send;
    if (available(port))
      port?.onRequest?.({
        operation: { ...props.operation },
        value: field === "code" ? props.code : props.email,
      });
  }
  function dismiss() {
    if (available(props.dismiss))
      props.dismiss?.onRequest?.({ ...props.operation });
  }
  $effect(() => {
    if (!props.open || !sheet) return;
    const release = trapFocus({
      container: () => sheet,
      focusable,
      onDismiss: dismiss,
    });
    untrack(() => {
      const first = sheet?.querySelector<HTMLElement>(focusable);
      first?.focus();
    });
    return release;
  });
  $effect(() => {
    const node = input;
    const stage = field;
    if (props.open && node && stage)
      untrack(() => {
        if (!node.disabled) node.focus();
      });
  });
</script>

<div class="still-ui" style="position:relative;height:100%;overflow:hidden;">
  <div
    inert={props.open}
    aria-hidden={props.open ? "true" : undefined}
    style="height:100%;"
  >
    <PurchaseView {...background} />
  </div>
  {#if props.open}
    <button
      type="button"
      class="scrim"
      style="position:absolute;"
      tabindex="-1"
      aria-label="Cancel"
      aria-hidden="true"
      onclick={dismiss}
    ></button>
    <div
      bind:this={sheet}
      class="sheet"
      style="position:absolute;max-block-size:100%;"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby={id + "-title"}
      aria-describedby={id + "-body"}
    >
      <div class="grip" aria-hidden="true"></div>
      <h2 id={id + "-title"}>
        {props.operation.purpose === "restore"
          ? "Sign in to restore Still Pro"
          : "Sign in to get Still Pro"}
      </h2>
      <p class="body" id={id + "-body"}>
        {props.operation.purpose === "restore"
          ? "Use the account you bought Still Pro with."
          : "Your purchase is saved to your Still account, so you can restore it in other browsers."}
      </p>
      {#if field}
        <form
          style="display:flex;flex-direction:column;gap:var(--space-3);"
          onsubmit={submit}
        >
          <div style="display:flex;flex-direction:column;gap:var(--space-3);">
            <label
              class="field-label"
              for={id + "-input"}
              style="margin-block-end:calc(-1 * var(--space-2));"
              >{field === "code" ? "6-digit code" : "Email address"}</label
            >
            <input
              bind:this={input}
              id={id + "-input"}
              class:code={field === "code"}
              class="field"
              type={field === "email" ? "email" : "text"}
              inputmode={field === "code" ? "numeric" : "email"}
              autocomplete={field === "code" ? "one-time-code" : "email"}
              placeholder={field === "email" ? "you@example.com" : undefined}
              value={field === "code" ? props.code : props.email}
              disabled={!editable}
              oninput={edit}
            />
          </div>
          {#if current && props.observation?.text}<p
              class={operationState === "failed" ? "error" : "hint"}
              role="status"
            >
              {props.observation.text}
            </p>{/if}
          <button
            type="submit"
            class="primary"
            disabled={!canSubmit}
            aria-busy={pending ? "true" : undefined}
            >{field === "code" ? "Sign in" : "Send code"}</button
          >
        </form>
      {:else if current && props.observation?.text && (operationState !== "confirmed" || confirmed)}
        <p class="hint" role="status">{props.observation.text}</p>
      {/if}
      <button
        type="button"
        class="dismiss"
        aria-disabled={!available(props.dismiss)}
        onclick={dismiss}>Cancel</button
      >
    </div>
  {/if}
</div>
