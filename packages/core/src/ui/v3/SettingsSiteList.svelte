<script lang="ts">
  import { untrack } from "svelte";
  import type { ServiceId } from "@still/shared-types";
  import { rowsFor } from "./presentation.js";
  import type { SettingsSiteListProps } from "./extension-settings-presentation.js";
  import { serviceIconSrc } from "./service-icons.js";
  import Toggle from "./Toggle.svelte";
  import Glyph from "./Glyph.svelte";
  import FeatureRow from "./FeatureRow.svelte";
  let {
    settings,
    access,
    onServiceChange,
    onFeatureChange,
    sectionMemory,
    services = ["youtube", "instagram", "facebook", "tiktok"],
    features,
    labels = {},
    onProAction,
    commandsDisabled = false,
  }: SettingsSiteListProps = $props();
  let open = $state<ServiceId | null>(
    untrack(() => sectionMemory?.read() ?? null),
  );
  const titles = {
    youtube: "YouTube Blocker",
    instagram: "Instagram Blocker",
    facebook: "Facebook Blocker",
    tiktok: "TikTok Blocker",
  };
  const serviceLabels = {
    youtube: "Still on YouTube",
    instagram: "Still on Instagram",
    facebook: "Still on Facebook",
    tiktok: "TikTok website",
  };
  function toggleSection(service: ServiceId) {
    open = open === service ? null : service;
    sectionMemory?.write(open);
  }
</script>

<div
  class="service-group services"
  data-paused={!settings.globalOn || undefined}
>
  {#each services as service, index (service)}
    {#if index > 0}<div class="divider"></div>{/if}
    {@const rows = rowsFor(service).filter(
      (row) => !features || features.includes(row.id),
    )}
    <div class="site-section" data-paused={!settings.globalOn || undefined}>
      <div class="service-row">
        <span class="icon"
          ><img
            src={serviceIconSrc[service]}
            alt=""
            style="display:block;inline-size:100%;block-size:100%;"
          /></span
        >
        {#if rows.length > 0}
          <button
            type="button"
            class="expander"
            aria-expanded={open === service}
            aria-controls={`site-${service}-panel`}
            onclick={() => toggleSection(service)}
          >
            <span class="text"
              ><span class="name" id={`site-${service}-h`}
                >{titles[service]}</span
              ></span
            ><Glyph name="chevron" className="chevron" />
          </button>
        {:else}<div class="expander" style="cursor:default;">
            <span class="text"
              ><span class="name" id={`site-${service}-h`}
                >{titles[service]}</span
              ></span
            >
          </div>{/if}
        <Toggle
          checked={settings.services[service]}
          onChange={(next) => {
            if (!commandsDisabled) onServiceChange(service, next);
          }}
          disabled={!settings.globalOn || commandsDisabled}
          label={serviceLabels[service]}
        />
      </div>
      {#if rows.length > 0}
        <div
          id={`site-${service}-panel`}
          class="service-options"
          class:open={open === service}
          role="group"
          aria-labelledby={`site-${service}-h`}
        >
          <div class="inner">
            <div class="list">
              {#each rows as row (row.id)}
                {@const state = access.states[row.id]}
                {@const inactive =
                  !settings.globalOn ||
                  !settings.services[service] ||
                  commandsDisabled}
                {@const label = labels[row.id] ?? row.label}
                <FeatureRow
                  id={row.id}
                  {label}
                  {state}
                  checked={settings.sites[row.id]}
                  {inactive}
                  unsupportedText="Not available in this browser. Your choice is saved."
                  note={row.id === "instagram.explore"
                    ? "Search stays."
                    : undefined}
                  onChange={(next) => {
                    if (!commandsDisabled) onFeatureChange(row.id, next);
                  }}
                  onLock={onProAction}
                  lockLabel={`${label}. Included in Still Pro. See Still Pro`}
                />
              {/each}
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/each}
</div>
