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
  /** "Today at 2:10 PM", "Yesterday at 2:10 PM", else "Oct 15 at 2:24 PM" (owner, 19 Oct). */
  function syncTime(date: Date, now: Date = new Date()): string {
    const clock = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (date.toDateString() === now.toDateString()) return `Today at ${clock}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `Yesterday at ${clock}`;
    return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${clock}`;
  }
</script>

<!-- The compact sync status line (ISS-0056), shared by the popups and the Apple app's sync card
     (ISS-0061): "Synced · Today at 2:24 PM" (or "Oct 15 at 2:24 PM"). The label stays visible unless
     the status already says the sync succeeded, so an earlier time never reads as current. The
     time is not re-announced on its own each time it advances (aria-live off). -->
<span class="sync-summary">
  <span>{text}</span>
  {#if time}
    <span aria-hidden="true"> · </span>
    <span class="muted" aria-live="off"><span class:sr-only={tone === "success"}>{`${STRINGS.sync.lastSynced} `}</span><time
        datetime={time.toISOString()}
        >{syncTime(time)}</time
      ></span>
  {/if}
</span>

<style>
  .sync-summary {
    overflow-wrap: anywhere;
  }
</style>
