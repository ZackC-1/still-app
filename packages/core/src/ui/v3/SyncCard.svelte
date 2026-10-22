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
    stillPro,
    invitation,
    appHandoff = false,
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
<section class="card card-stack sync" data-still-card="sync">
  <!-- The same heading as the Still Pro and Share usage data cards (owner, 12 Oct). -->
  <!-- The Still Pro tag sits on the heading row, right-aligned, in the success green (owner,
    19 Oct): the one signal on this screen that the person has Still Pro. -->
  <div class="offer-head">
    <h2 class="card-title">Settings sync</h2>
    {#if stillPro}<StillProTag kind={stillPro} />{/if}
  </div>
  {#if account}
    {#if account.address}<p class="synced account-line">
        <span class="account-address">{account.address}</span>
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
      <!-- No divider or extra space above Sign out (owner, 21 Oct); the popup's row keeps its own. -->
      <div class="sync-account">
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
  {:else if invitation}
    <!-- The accountless holder's invitation lives here (owner, 19 Oct): Sign in and Not now,
      then the one line that says why. -->
    <div class="split-actions">
      <button
        type="button"
        class="primary block"
        disabled={!invitation.onAccept}
        onclick={invitation.onAccept}>Sign in</button
      >
      <button
        type="button"
        class="secondary block"
        disabled={!invitation.onDismiss}
        onclick={invitation.onDismiss}>Not now</button
      >
    </div>
    <p class="card-body">
      You have Still Pro. Sign in to keep Still Pro with your account.
    </p>
  {:else}
    <!-- Owner (19 Oct screens review): the button sits above the line, and the line uses the
      Still Pro card's body size, so the signed-out card stays compact. -->
    <button
      type="button"
      class="primary block"
      aria-describedby={appHandoff ? "sync-signin-handoff" : undefined}
      disabled={!onSignIn}
      onclick={onSignIn}>Sign in</button
    >
    <!-- Safari: the Still app owns the account, so Sign in opens the app and says so, as in the
      Safari popups' signed-out sync row. -->
    {#if appHandoff}<p
        class="handoff"
        id="sync-signin-handoff"
        style="justify-content:center;"
      >
        Opens the Still app
      </p>{/if}
    <p class="card-body">
      Sync settings across devices and browsers. Free.
    </p>
  {/if}
  {#if accountActions}{@render accountActions()}{/if}
</section>
