<script lang="ts">
  import { untrack } from "svelte";
  import type { ServiceId } from "@still/shared-types";
  import { rowsFor } from "./presentation.js";
  import type { SettingsSiteListProps } from "./extension-settings-presentation.js";
  import { serviceIconSrc } from "./service-icons.js";
  import Toggle from "./Toggle.svelte";
  import Glyph from "./Glyph.svelte";
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
          onChange={(next) => onServiceChange(service, next)}
          disabled={!settings.globalOn}
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
                {@const usable =
                  state === "free" ||
                  state === "purchased" ||
                  state === "protected"}
                {@const inactive =
                  !settings.globalOn || !settings.services[service]}
                {@const label = labels[row.id] ?? row.label}
                {@const key = row.id.replace(/\W+/g, "-")}
                {@const note =
                  state === "unsupported"
                    ? "Not available in this browser. Your choice is saved."
                    : row.id === "instagram.explore"
                      ? "Search stays."
                      : undefined}
                {@const srNote =
                  state === "checking"
                    ? "Checking your Still Pro access. Your choice is saved."
                    : state === "verification_required"
                      ? "Verify Still Pro to use this. Your choice is saved."
                      : undefined}
                <div
                  class="option-row"
                  data-access={state === "verification_required"
                    ? "verify"
                    : state}
                  data-inactive={inactive ||
                    state === "unsupported" ||
                    state === "locked" ||
                    undefined}
                >
                  <div class="row-main">
                    <span class="label"
                      ><span id={`${key}-l`}>{label}</span></span
                    >
                    {#if note}<span class="sub" id={`${key}-s`}>{note}</span
                      >{:else if srNote}<span class="sr-only" id={`${key}-s`}
                        >{srNote}</span
                      >{/if}
                  </div>
                  {#if usable || state === "checking" || state === "verification_required"}
                    <Toggle
                      small
                      checked={settings.sites[row.id]}
                      onChange={(next) => onFeatureChange(row.id, next)}
                      disabled={inactive || !usable}
                      labelledBy={`${key}-l`}
                      describedBy={note || srNote ? `${key}-s` : undefined}
                    />
                  {:else if state === "locked"}
                    <button
                      type="button"
                      class="lock-pro"
                      aria-label={`${label}. Included in Still Pro. See Still Pro`}
                      aria-disabled={!onProAction || undefined}
                      onclick={() => {
                        onProAction?.();
                      }}
                      ><Glyph name="lock" size={14} /><span>Still Pro</span
                      ></button
                    >
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/each}
</div>
