<script lang="ts">
  import { STRINGS } from "../strings.js";
  let {
    text,
    tone,
    lastSyncedAt,
  }: {
    text: string;
    tone: "pending" | "success" | "failed" | "caution" | "info";
    /** Last successful cloud exchange (ms), never an attempt or a local edit. */
    lastSyncedAt?: number | null;
  } = $props();
  // An unrepresentable value shows no time rather than throwing while rendering.
  let time = $derived.by(() => {
    if (typeof lastSyncedAt !== "number") return undefined;
    const date = new Date(lastSyncedAt);
    return Number.isNaN(date.getTime()) ? undefined : date;
  });
</script>

<!-- The compact sync status line (ISS-0056), shared by the popups and the Apple app's sync card
     (ISS-0061): "Synced with your account. · Oct 15, 2:24 PM". The label stays visible unless
     the status already says the sync succeeded, so an earlier time never reads as current. The
     time is not re-announced on its own each time it advances (aria-live off). -->
<span class="sync-summary">
  <span>{text}</span>
  {#if time}
    <span aria-hidden="true"> · </span>
    <span class="muted" aria-live="off"><span class:sr-only={tone === "success"}>{`${STRINGS.sync.lastSynced} `}</span><time
        datetime={time.toISOString()}
        >{time.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}</time
      ></span>
  {/if}
</span>

<style>
  .sync-summary {
    overflow-wrap: anywhere;
  }
</style>
