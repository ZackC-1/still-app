<script lang="ts">
  import type { SettingsSiteListProps } from "../../../../../packages/core/src/ui/v3/extension-settings-presentation.js";
  import type { ServiceId } from "@still/shared-types";
  import SettingsSiteList from "../../../../../packages/core/src/ui/v3/SettingsSiteList.svelte";
  import Toggle from "../../../../../packages/core/src/ui/v3/Toggle.svelte";
  import Glyph from "../../../../../packages/core/src/ui/v3/Glyph.svelte";

  // Unregistered artwork composition. Every view is supplied explicitly by the
  // reference-only renderer; this never reads settings or establishes access.
  let {
    id,
    headline,
    body,
    view,
  }: {
    id: string;
    headline: string;
    body: string;
    view: Pick<SettingsSiteListProps, "settings" | "access" | "services"> & {
      purpose: "synthetic-reference-only";
      open: ServiceId | null;
      account: { address: string; status: string } | null;
    };
  } = $props();

  const noOperation = () => {};
</script>

<div
  {id}
  data-asset=""
  data-purpose={view.purpose}
  inert
  style="width:1280px;height:800px;background:#2a47e8;color:#fff;position:relative;overflow:hidden;font-family:var(--font-ui);"
>
  <div
    style="position:absolute;left:88px;top:0;bottom:0;width:520px;display:flex;flex-direction:column;justify-content:center;gap:20px;"
  >
    <p
      style="margin:0;font-size:60px;line-height:1.08;font-weight:700;letter-spacing:-0.02em;"
    >
      {headline}
    </p>
    <p
      style="margin:0;font-size:26px;line-height:1.35;color:rgba(255,255,255,.9);"
    >
      {body}
    </p>
  </div>
  <div
    class="still-ui"
    data-theme="light"
    style="position:absolute;transform-origin:0 0;transform:scale(1.2);width:380px;border-radius:16px;overflow:hidden;background:var(--surface);left:728px;top:40px;"
  >
    <div
      class="still-ui app"
      data-density="compact"
      style="max-inline-size:380px;"
    >
      <section class="hero compact">
        <div class="hero-text"><h1>Still is active</h1></div>
        <Toggle checked={view.settings.globalOn} label="Still" onBlue />
      </section>
      <SettingsSiteList
        settings={view.settings}
        access={view.access}
        services={view.services}
        onServiceChange={noOperation}
        onFeatureChange={noOperation}
        sectionMemory={{ read: () => view.open, write: noOperation }}
      />
      <section class="card card-stack">
        <div class="sync-row">
          <div class="sync-row-text">
            <h2 class="sync-row-title">Settings sync</h2>
            <p class="muted sync-row-sub">
              {view.account
                ? view.account.address
                : "Free. Keep your settings updated across every device and browser"}
            </p>
          </div>
          {#if !view.account}<button type="button" class="primary inline"
              >Sign in</button
            >{/if}
        </div>
        {#if view.account}
          <div class="status-line" data-tone="success">
            <span class="glyph"><Glyph name="check" size={16} /></span>
            <div class="status-body"><span>{view.account.status}</span></div>
          </div>
        {/if}
      </section>
      <footer class="popup-footer">
        <button
          type="button"
          class="open-options"
          aria-label="Settings. Find Still in Chrome.">Settings</button
        >
        <a class="link" href="#reference-privacy-policy">Privacy policy</a>
      </footer>
    </div>
  </div>
</div>
