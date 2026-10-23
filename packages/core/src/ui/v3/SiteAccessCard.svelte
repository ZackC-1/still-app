<script lang="ts">
  import {
    SITE_ACCESS_COPY,
    siteAccessBody,
    siteAccessDeclinedText,
    siteAccessPendingText,
    siteAccessTitle,
    type SiteAccessCardProps,
  } from "./site-access-presentation.js";
  import Glyph from "./Glyph.svelte";

  // ISS-0037: the top-of-screen warning in the popup and the settings page while Still cannot run
  // on its sites. The host supplies the browser's answer and the request; this only draws it.
  // One button stays in place from Allow through "Waiting for…" to Try again, so focus never
  // drops; the status line is always present, so each change is announced; when access comes
  // back the card says so (and to reload open tabs) and takes focus if the button had it.
  let { state: access, browser, sites, onAllow }: SiteAccessCardProps = $props();
  let heading = $state<HTMLElement>();
  let asked = false;
  let title = $derived(
    access === "allowed" ? SITE_ACCESS_COPY.allowed : siteAccessTitle(sites),
  );
  let status = $derived(
    access === "pending"
      ? siteAccessPendingText(browser)
      : access === "denied"
        ? `${siteAccessDeclinedText(browser)} ${SITE_ACCESS_COPY.declinedDetail}`
        : access === "allowed"
          ? SITE_ACCESS_COPY.reload
          : "",
  );
  function allow() {
    if (access !== "needed" && access !== "denied") return;
    asked = true;
    onAllow?.();
  }
  $effect(() => {
    if (access === "allowed" && asked) heading?.focus();
  });
</script>

<section class="card card-stack" data-site-access={access} aria-label={title}>
  <div
    class="status-line"
    data-tone={access === "allowed" ? "success" : "caution"}
  >
    <span class="glyph"
      ><Glyph name={access === "allowed" ? "check" : "alert"} size={16} /></span
    >
    <div class="status-body">
      <h2 class="card-title" tabindex="-1" bind:this={heading}>{title}</h2>
      {#if access !== "allowed"}<p class="card-body">{siteAccessBody(sites)}</p>{/if}
      <p class="card-body" role="status" data-empty={!status || undefined}>{status}</p>
    </div>
  </div>
  {#if access !== "allowed" && onAllow}<button
      type="button"
      class="primary block"
      aria-disabled={access === "pending" || undefined}
      aria-busy={access === "pending" || undefined}
      onclick={allow}
      >{access === "denied" ? SITE_ACCESS_COPY.retry : SITE_ACCESS_COPY.allow}</button
    >{/if}
</section>
