<script lang="ts">
  import type { PurchaseViewProps } from "./purchase-presentation.js";
  import type { OperationStatus } from "./extension-settings-presentation.js";
  import Glyph from "./Glyph.svelte";
  import "./design/styles.css";
  import "./apple-onboarding-layout.css";

  let props: PurchaseViewProps = $props();
  let owned = $derived(
    props.access.verified &&
      (props.access.state === "owned" || props.access.state === "purchased"),
  );
  let completed = $derived(
    props.access.verified &&
      ["owned", "purchased", "protected", "free"].includes(props.access.state),
  );
  let confirmedAccount = $derived(
    props.host === "browser" &&
      props.account?.confirmed &&
      Boolean(props.account.id.trim()),
  );
  let restoreState = $derived(
    props.restore?.verified &&
      props.restore.state !== "unknown" &&
      (!["nothing", "restored"].includes(props.restore.state) ||
        props.restore.conclusive)
      ? props.restore.state
      : undefined,
  );
  let restoreHeld = $derived(
    Boolean(props.restore) && restoreState !== "nothing",
  );
  let confirmedSuccess = $derived(
    props.purchase.state === "success" && props.purchase.confirmed,
  );
  let trustedRoute = $derived(
    props.host === "apple" ? props.native.verified : props.checkout.verified,
  );
  let acquisitionAuthority = $derived(
    props.access.verified &&
      props.access.state === "none" &&
      props.channel === "ready" &&
      props.offer?.verified &&
      Boolean(props.offer.price.trim()) &&
      trustedRoute &&
      !restoreHeld,
  );
  let canAcquire = $derived(
    acquisitionAuthority &&
      (props.purchase.state === "idle" || props.purchase.state === "failed"),
  );
  let actionAvailable = $derived(
    props.host === "apple"
      ? Boolean(props.native.onBuy)
      : confirmedAccount
        ? Boolean(props.checkout.onRequest)
        : Boolean(props.onSignIn),
  );
  let restoreAvailable = $derived(
    props.host === "apple"
      ? props.native.verified && Boolean(props.native.onRestore)
      : props.restorePort.verified &&
          (confirmedAccount
            ? Boolean(props.restorePort.onRequest)
            : Boolean(props.onSignIn)),
  );
  let restoreAllowed = $derived(
    !completed && props.purchase.state !== "success" && !restoreHeld,
  );
  let groups = $derived.by(() => {
    const result: [string, string[]][] = [];
    for (const control of props.controls) {
      let group = result.find(([site]) => site === control.site);
      if (!group) result.push((group = [control.site, []]));
      group[1].push(control.label);
    }
    return result;
  });
  const restoreMessages = {
    checking: { tone: "pending", text: "Checking for Still Pro purchases…" },
    restored: {
      tone: "success",
      text: "Still Pro is restored on this device.",
    },
    nothing: {
      tone: "info",
      text: "No Still Pro purchase was found for this account.",
      detail:
        "Bought it with another account or Apple ID? Sign in with that one and try again.",
    },
    failed: {
      tone: "failed",
      text: "We couldn't finish checking. Nothing changed.",
      detail: "Your free controls and saved choices are unaffected.",
      actionLabel: "Try again",
    },
    verify: {
      tone: "caution",
      text: "Still Pro needs to be verified again.",
      detail:
        "Go online and sign in. Free controls and your saved choices stay.",
      actionLabel: "Verify now",
    },
  } satisfies Record<string, OperationStatus>;
  function acquire() {
    if (!canAcquire) return;
    if (props.host === "apple") props.native.onBuy?.();
    else if (confirmedAccount) props.checkout.onRequest?.();
    else props.onSignIn?.("purchase");
  }
  function restore() {
    if (!restoreAllowed || !restoreAvailable) return;
    if (props.host === "apple") props.native.onRestore?.();
    else if (confirmedAccount) props.restorePort.onRequest?.();
    else props.onSignIn?.("restore");
  }
  function restoreAction() {
    if (
      props.restore?.verified &&
      (props.restore.state === "failed" || props.restore.state === "verify")
    )
      props.restore.onAction?.();
  }
</script>

{#snippet status(operation: OperationStatus)}
  <div
    class="status-line"
    data-tone={operation.tone}
    role={operation.tone === "failed" ? "alert" : "status"}
  >
    {#if operation.tone !== "info"}<span class="glyph"
        ><Glyph
          name={operation.tone === "pending"
            ? "spinner"
            : operation.tone === "success"
              ? "check"
              : operation.tone === "failed"
                ? "alert"
                : "clock"}
          size={16}
        /></span
      >{/if}
    <div class="status-body">
      <span>{operation.text}</span>
      {#if operation.detail}<span
          class="muted"
          style="font-size:calc(12.5px * var(--text-scale, 1));"
          >{operation.detail}</span
        >{/if}
      {#if operation.actionLabel}<button
          type="button"
          class="link status-action"
          disabled={!operation.onAction}
          onclick={operation.onAction}>{operation.actionLabel}</button
        >{/if}
    </div>
  </div>
{/snippet}

<main class="still-ui ob">
  <div class="ob-col">
    <div class="ob-top">
      <button
        type="button"
        class="link"
        disabled={!props.onBack}
        onclick={() => props.onBack?.()}
        >{props.host === "apple" ? "Close" : "Back to settings"}</button
      ><span></span>
    </div>
    <div class="ob-main" style="justify-content:flex-start;gap:16px;">
      <h1>Still Pro</h1>
      <p class="lede">
        More control over YouTube, Instagram and Facebook. One payment. Access
        forever. No subscription
      </p>
      <section class="card card-stack">
        <div style="display:flex;flex-direction:column;gap:10px;">
          {#each groups as [site, items] (site)}<div>
              <p class="offer-site">{site} Blocking Options</p>
              <ul class="offer-list">
                {#each items as item, index (index)}<li>{item}</li>{/each}
              </ul>
            </div>{/each}
        </div>
      </section>
      {#if props.purchase.state === "failed"}{@render status({
          tone: "failed",
          text: "The purchase wasn't confirmed.",
          detail: "If you were charged, Restore purchase will find it.",
        })}{/if}
      {#if restoreState}{@render status({
          ...restoreMessages[restoreState],
          onAction:
            props.restore?.onAction &&
            (restoreState === "failed" || restoreState === "verify")
              ? restoreAction
              : undefined,
        })}{/if}
    </div>
    <div class="ob-actions">
      {#if owned}
        {@render status({
          tone: "success",
          text: "You have Still Pro.",
          detail: "New controls start off. Turn on the ones you want.",
        })}
      {:else if !restoreHeld && !completed}
        {#if props.access.verified && props.access.state === "checking"}
          {@render status({
            tone: "pending",
            text: "Checking your Still Pro access…",
            detail: "Your free controls keep working.",
          })}
        {:else if props.access.verified && (props.access.state === "verify" || props.access.state === "failed")}
          {@render status(restoreMessages[props.access.state])}
        {:else if confirmedSuccess}
          {@render status({
            tone: "success",
            text: "Still Pro is ready.",
            detail: "New controls start off. Turn on the ones you want.",
          })}
        {:else if props.purchase.state !== "success" && props.access.verified && props.access.state !== "unknown"}
          {#if !acquisitionAuthority}
            {@render status({
              tone: "info",
              text: "Still Pro can't be bought here yet.",
              detail: "Already bought it somewhere else? Restore it below.",
            })}
          {:else if props.purchase.state === "pending"}
            <button
              type="button"
              class="primary block"
              aria-busy="true"
              aria-disabled="true"
              onclick={acquire}
              >{props.host === "apple"
                ? "Waiting for Apple…"
                : "Waiting for checkout…"}</button
            >
          {:else}
            <button
              type="button"
              class="primary block"
              disabled={!actionAvailable}
              onclick={acquire}>Get Still Pro</button
            >
          {/if}
        {/if}
      {/if}
      {#if confirmedSuccess}<button
          type="button"
          class="secondary block"
          disabled={!props.onBack}
          onclick={() => props.onBack?.()}>Back to settings</button
        >{/if}
      {#if restoreAllowed}<button
          type="button"
          class="link"
          disabled={!restoreAvailable}
          onclick={restore}>Restore purchase</button
        >{/if}
      {#if acquisitionAuthority && (canAcquire || props.purchase.state === "pending")}<p
          class="caption"
          style="text-align:center;"
        >
          {props.host === "apple"
            ? "Payment is handled by Apple. No account needed."
            : confirmedAccount
              ? "Checkout opens in a new tab."
              : "You'll sign in first, so you can restore Still Pro in other browsers."}
        </p>{/if}
    </div>
  </div>
</main>
