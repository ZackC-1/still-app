<script lang="ts">
  // The screen inside the V1 review frame is the BUILT page itself, in an iframe that fills the
  // frame's page area (the simulated popup, sheet or web view viewport). The page runs on its own
  // origin with the recorded-state shim installed by the harness; this file only places it.
  let { src, height }: { src: string; height?: number } = $props();
</script>

<iframe
  title="Page under test"
  {src}
  data-page-under-test
  style={`display:block;border:0;width:100%;height:${height ? `${height}px` : "100%"};background:transparent;`}
></iframe>
