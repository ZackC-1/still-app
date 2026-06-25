<script lang="ts">
  import type { ServiceId } from "@still/shared-types";

  // Real, recognizable brand marks as inline SVG (no external fetch — works over the WKWebView file://
  // origin). App-icon style (rounded square) to match each service's own icon; Facebook keeps its disc.
  interface Props {
    service: ServiceId;
    size?: number;
  }
  let { service, size = 40 }: Props = $props();
</script>

<span class="icon" style="--s:{size}px" aria-hidden="true">
  {#if service === "youtube"}
    <svg viewBox="0 0 48 48" width={size} height={size}>
      <rect width="48" height="48" rx="13" fill="#FF0033" />
      <path d="M20 16.5 L33 24 L20 31.5 Z" fill="#fff" />
    </svg>
  {:else if service === "instagram"}
    <svg viewBox="0 0 48 48" width={size} height={size}>
      <defs>
        <linearGradient id="ig-grad" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stop-color="#FFD776" />
          <stop offset="0.28" stop-color="#F58529" />
          <stop offset="0.62" stop-color="#DD2A7B" />
          <stop offset="1" stop-color="#8134AF" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#ig-grad)" />
      <rect x="13.5" y="13.5" width="21" height="21" rx="6.5" fill="none" stroke="#fff" stroke-width="2.6" />
      <circle cx="24" cy="24" r="5.4" fill="none" stroke="#fff" stroke-width="2.6" />
      <circle cx="30.6" cy="17.4" r="1.7" fill="#fff" />
    </svg>
  {:else if service === "tiktok"}
    <svg viewBox="0 0 48 48" width={size} height={size}>
      <rect width="48" height="48" rx="13" fill="#000" />
      <g transform="translate(1.4,-1.1)" fill="#25F4EE"><path d="M27 14h3.4c.4 3.1 2.6 5.4 5.6 5.7v3.5c-1.8 0-3.5-.5-5-1.4v6.9a7.6 7.6 0 1 1-7.6-7.6c.4 0 .8 0 1.2.1v3.7a4 4 0 1 0 2.8 3.8V14z" /></g>
      <g transform="translate(-1.4,1.1)" fill="#FE2C55"><path d="M27 14h3.4c.4 3.1 2.6 5.4 5.6 5.7v3.5c-1.8 0-3.5-.5-5-1.4v6.9a7.6 7.6 0 1 1-7.6-7.6c.4 0 .8 0 1.2.1v3.7a4 4 0 1 0 2.8 3.8V14z" /></g>
      <path d="M27 14h3.4c.4 3.1 2.6 5.4 5.6 5.7v3.5c-1.8 0-3.5-.5-5-1.4v6.9a7.6 7.6 0 1 1-7.6-7.6c.4 0 .8 0 1.2.1v3.7a4 4 0 1 0 2.8 3.8V14z" fill="#fff" />
    </svg>
  {:else}
    <svg viewBox="0 0 48 48" width={size} height={size}>
      <circle cx="24" cy="24" r="24" fill="#1877F2" />
      <path d="M27.3 25.5l.74-4.78h-4.58v-3.1c0-1.31.64-2.58 2.7-2.58h2.08v-4.07s-1.89-.32-3.7-.32c-3.77 0-6.24 2.29-6.24 6.43v3.64h-4.2v4.78h4.2v11.56a16.7 16.7 0 0 0 5.16 0V25.5z" fill="#fff" />
    </svg>
  {/if}
</span>

<style>
  .icon {
    display: inline-flex;
    inline-size: var(--s);
    block-size: var(--s);
    flex: none;
  }
  .icon svg {
    display: block;
  }
</style>
