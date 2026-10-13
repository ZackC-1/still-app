<script lang="ts">
  import {
    SITE_ACCESS_COPY,
    siteAccessDeclinedText,
    siteAccessPendingText,
    type SiteAccessCardProps,
  } from "./site-access-presentation.js";
  import Glyph from "./Glyph.svelte";

  // ISS-0037: the top-of-screen warning in the popup and the settings page while Still cannot run
  // on its four sites. The host supplies the browser's answer and the request; this only draws it.
  let { state, browser, onAllow }: SiteAccessCardProps = $props();
  const id = $props.id();
</script>

<section
  class="card card-stack"
  data-site-access={state}
  aria-labelledby={`${id}-title`}
>
  <div class="status-line" data-tone="caution">
    <span class="glyph"><Glyph name="alert" size={16} /></span>
    <div class="status-body">
      <h2 class="card-title" id={`${id}-title`}>{SITE_ACCESS_COPY.title}</h2>
      <p class="card-body">{SITE_ACCESS_COPY.body}</p>
      {#if state === "denied"}<p class="card-body" role="status">
          {siteAccessDeclinedText(browser)}
          {SITE_ACCESS_COPY.declinedDetail}
        </p>{/if}
    </div>
  </div>
  {#if state === "pending"}
    <div class="status-line" data-tone="pending" role="status">
      <span class="glyph"><Glyph name="spinner" size={16} /></span>
      <div class="status-body">
        <span>{siteAccessPendingText(browser)}</span>
      </div>
    </div>
  {:else if onAllow}<button type="button" class="primary block" onclick={() => onAllow()}
      >{state === "denied"
        ? SITE_ACCESS_COPY.retry
        : SITE_ACCESS_COPY.allow}</button
    >{/if}
</section>
