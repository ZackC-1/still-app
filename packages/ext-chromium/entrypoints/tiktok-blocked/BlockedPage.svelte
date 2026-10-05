<script lang="ts">
  import { tick } from "svelte";
  import TikTokBlocked from "../../../core/src/ui/v3/TikTokBlocked.svelte";
  import type { TikTokBlockedPresentation } from "../../../core/src/ui/v3/tiktok-blocked-presentation.js";

  let {
    host,
  }: {
    host: {
      current(): TikTokBlockedPresentation;
      subscribe(listener: (presentation: TikTokBlockedPresentation) => void): () => void;
    };
  } = $props();

  let presentation = $state.raw<TikTokBlockedPresentation>(host.current());
  $effect(() =>
    host.subscribe((next) => {
      // Each new observation re-keys the page actions, so the focused control can disappear
      // (blocked -> pending -> confirmation, confirm -> pending -> reload). When the person was
      // using the page, keep keyboard focus on its first action rather than the document, and
      // never move it out of an open dialog. Nothing is focused on a page nobody has touched.
      const before = document.activeElement;
      const engaged = before instanceof Element && before !== document.body && !!before.closest("main");
      presentation = next;
      if (!engaged) return;
      void tick().then(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        if (document.querySelector('[role="dialog"]')) return;
        document.querySelector<HTMLElement>(".blocked-actions button")?.focus();
      });
    }),
  );
</script>

<TikTokBlocked {presentation} />
