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
    browser = "Chrome",
    kind = "landscape",
    width = 1280,
    height = 800,
    uiBase = 3,
    icon,
    view,
  }: {
    id: string;
    headline: string;
    body: string;
    browser?: "Chrome" | "Firefox" | "Safari";
  } & (
    | {
        kind?: "landscape" | "portrait";
        width?: number;
        height?: number;
        uiBase?: number;
        icon?: never;
        view: Pick<
          SettingsSiteListProps,
          "settings" | "access" | "services" | "features"
        > & {
          purpose: "synthetic-reference-only";
          open: ServiceId | null;
          account: { address: string; status: string } | null;
        };
      }
    | {
        kind: "tile";
        width: number;
        height: number;
        icon: string;
        uiBase?: never;
        view?: never;
      }
  ) = $props();

  const noOperation = () => {};
  const portrait = $derived(kind === "portrait");
  const k = $derived(portrait ? width / 1320 : height / 800);
  const copyLayout = $derived(
    portrait
      ? `left:${110 * k}px;right:${110 * k}px;top:${200 * k}px;gap:${36 * k}px;`
      : `left:${88 * k}px;top:0;bottom:0;width:${520 * k}px;justify-content:center;gap:${20 * k}px;`,
  );
  const uiScale = $derived(portrait ? uiBase * k : 1.2 * k);
  const uiLeft = $derived(
    portrait ? (width - 380 * uiBase * k) / 2 : width - (380 * 1.2 + 96) * k,
  );
  const uiTop = $derived(
    portrait ? Math.min(900 * k, height - 600 * uiBase * k - 120 * k) : 40 * k,
  );
</script>

<div
  {id}
  data-asset=""
  data-purpose={view?.purpose ?? "synthetic-reference-only"}
  inert
  style={`width:${width}px;height:${height}px;background:#2a47e8;color:#fff;position:relative;overflow:hidden;font-family:var(--font-ui);`}
>
  {#if kind === "tile"}
    <div
      style={`position:absolute;inset:0;display:flex;align-items:center;gap:${height * 0.1}px;padding:0 ${height * 0.16}px;`}
    >
      <img
        src={icon}
        alt=""
        style={`width:${height * 0.36}px;height:${height * 0.36}px;border-radius:${height * 0.08}px;`}
      />
      <div style={`display:flex;flex-direction:column;gap:${height * 0.03}px;`}>
        <span
          style={`font-size:${height * 0.2}px;font-weight:700;letter-spacing:-0.02em;line-height:1;`}
          >{headline}</span
        >
        <span
          style={`font-size:${height * 0.075}px;color:rgba(255,255,255,.9);`}
          >{body}</span
        >
      </div>
    </div>
  {:else if view}
    <div
      style={`position:absolute;display:flex;flex-direction:column;${copyLayout}`}
    >
      <p
        style={`margin:0;font-size:${(portrait ? 120 : 60) * k}px;line-height:${portrait ? 1.05 : 1.08};font-weight:700;letter-spacing:-0.02em;`}
      >
        {headline}
      </p>
      <p
        style={`margin:0;font-size:${(portrait ? 52 : 26) * k}px;line-height:${portrait ? 1.3 : 1.35};color:rgba(255,255,255,.9);`}
      >
        {body}
      </p>
    </div>
    <div
      class="still-ui"
      data-theme="light"
      style={`position:absolute;transform-origin:0 0;transform:scale(${uiScale});width:380px;border-radius:16px;overflow:hidden;background:var(--surface);left:${uiLeft}px;top:${uiTop}px;`}
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
          features={view.features}
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
            aria-label={"Settings. Find Still in " + browser + "."}
            >Settings</button
          >
          <a class="link" href="#reference-privacy-policy">Privacy policy</a>
        </footer>
      </div>
    </div>
  {/if}
</div>
