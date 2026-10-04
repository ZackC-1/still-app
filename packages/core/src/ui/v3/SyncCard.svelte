<script lang="ts">
  import type { SyncCardProps } from "./extension-settings-presentation.js";
  import Glyph from "./Glyph.svelte";
  let { account, owned = false, onSignIn }: SyncCardProps = $props();
  const icons = {
    pending: "spinner",
    success: "check",
    failed: "alert",
    caution: "clock",
  } as const;
</script>

<section class="card card-stack">
  <h2 class="section-label">
    {owned ? "Still Pro and sync" : "Settings sync"}
  </h2>
  {#if owned}
    <div
      style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding-block-end:12px;border-block-end:1px solid var(--border);"
    >
      <span
        class="row-title"
        style="font-size:calc(15px * var(--text-scale, 1));font-weight:600;"
        >Still Pro</span
      >
      <span class="access-tag boxed">Purchased</span>
    </div>
  {/if}
  {#if account}
    <p class="synced">{account.address}</p>
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
          <span>{account.status.text}</span>
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
  {:else}
    <p class="muted">
      Free. Keep your settings updated across every supported surface
    </p>
    <button
      type="button"
      class="primary block"
      disabled={!onSignIn}
      onclick={onSignIn}>Sign in</button
    >
  {/if}
</section>
