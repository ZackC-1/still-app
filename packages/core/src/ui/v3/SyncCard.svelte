<script lang="ts">
  import type { SyncCardProps } from "./extension-settings-presentation.js";
  import Glyph from "./Glyph.svelte";
  import SyncSummary from "./SyncSummary.svelte";
  import StillProTag from "./StillProTag.svelte";
  import {
    SHARED_DATA_COPY,
    WITHDRAWAL_OUTCOMES,
    WITHDRAWAL_RETRY,
  } from "./withdrawal-copy.js";
  let {
    account,
    onSignIn,
    accountActions,
    stillPro = false,
  }: SyncCardProps = $props();
  const icons = {
    pending: "spinner",
    success: "check",
    failed: "alert",
    caution: "clock",
  } as const;
  let shared = $derived(account?.sharedData);
  let sharedOutcome = $derived(
    shared && shared.withdrawal !== "none"
      ? WITHDRAWAL_OUTCOMES[shared.withdrawal]
      : undefined,
  );
  // The action is offered when nothing is on its way or waiting for "Try again".
  let sharedOffered = $derived(
    shared !== undefined &&
      (shared.withdrawal === "none" || shared.withdrawal === "deleted"),
  );
</script>

<!-- data-still-card: the Apple app's still://sync link scrolls to this card (apple-sync-route). -->
<section class="card card-stack" data-still-card="sync">
  <!-- The same heading as the Still Pro and Share usage data cards (owner, 12 Oct). -->
  <h2 class="card-title">Settings sync</h2>
  {#if account}
    {#if account.address || stillPro}<p class="synced account-line">
        {#if account.address}<span class="account-address"
            >{account.address}</span
          >{/if}
        {#if stillPro}<StillProTag />{/if}
      </p>{/if}
    {#if account.status}
      <div
        class="status-line"
        data-tone={account.status.tone}
        role={account.status.tone === "failed" ? "alert" : "status"}
      >
        {#if account.status.tone !== "info"}<span class="glyph"
            ><Glyph name={icons[account.status.tone]} size={16} /></span
          >{/if}
        <div class="status-body">
          {#if account.lastSyncedAt != null}
            <SyncSummary
              text={account.status.text}
              tone={account.status.tone}
              lastSyncedAt={account.lastSyncedAt}
            />
          {:else}
            <span>{account.status.text}</span>
          {/if}
          {#if account.status.detail}<span
              class="muted"
              style="font-size:calc(12.5px * var(--text-scale, 1));"
              >{account.status.detail}</span
            >{/if}
          {#if account.status.actionLabel && account.status.onAction}<button
              type="button"
              class="link status-action"
              onclick={account.status.onAction}
              >{account.status.actionLabel}</button
            >{/if}
        </div>
      </div>
    {/if}
    {#if account.onSignOut || account.onDeleteAccount}
      <div class="account">
        {#if account.onSignOut}
          <button
            type="button"
            class="link"
            disabled={!account.onSignOut}
            onclick={account.onSignOut}>Sign out</button
          >{/if}
        {#if account.onDeleteAccount}
          <button
            type="button"
            class="link danger"
            disabled={!account.onDeleteAccount}
            onclick={account.onDeleteAccount}>Delete account</button
          >{/if}
      </div>
    {/if}
    {#if shared}
      <div class="card-stack" data-shared-data>
        {#if sharedOffered}
          <button
            type="button"
            class="link danger"
            style="align-self:flex-start;"
            aria-describedby="shared-data-s"
            disabled={!shared.onDelete}
            onclick={shared.onDelete}>{SHARED_DATA_COPY.label}</button
          >
          <p class="caption" id="shared-data-s">{SHARED_DATA_COPY.sub}</p>
        {/if}
        {#if sharedOutcome}
          <div
            class="status-line"
            data-tone={sharedOutcome.tone}
            role={sharedOutcome.tone === "failed" ? "alert" : "status"}
          >
            <span class="glyph"
              ><Glyph
                name={sharedOutcome.tone === "pending"
                  ? "spinner"
                  : sharedOutcome.tone === "failed"
                    ? "alert"
                    : "check"}
                size={16}
              /></span
            >
            <div class="status-body">
              <span>{sharedOutcome.text}</span
              >{#if shared.withdrawal === "failed"}<button
                  type="button"
                  class="link status-action"
                  disabled={!shared.onRetry}
                  onclick={shared.onRetry}>{WITHDRAWAL_RETRY}</button
                >{/if}
            </div>
          </div>
        {/if}
        {#if shared.stoppedElsewhere}
          <div class="status-line" data-tone="info" role="status">
            <div class="status-body">
              <span>{SHARED_DATA_COPY.stoppedElsewhere}</span>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  {:else}
    <p class="muted">
      Free. Keep your block settings consistent across every supported device and browser.
    </p>
    {#if stillPro}<div class="account-signin">
        <StillProTag /><button
          type="button"
          class="primary block"
          disabled={!onSignIn}
          onclick={onSignIn}>Sign in</button
        >
      </div>{:else}<button
        type="button"
        class="primary block"
        disabled={!onSignIn}
        onclick={onSignIn}>Sign in</button
      >{/if}
  {/if}
  {#if accountActions}{@render accountActions()}{/if}
</section>
