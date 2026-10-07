<script lang="ts">
  let {
    controls,
    gap = 6,
  }: {
    controls: readonly { site: string; label: string }[];
    gap?: 6 | 10;
  } = $props();
  let groups = $derived.by(() => {
    const result: [string, string[]][] = [];
    for (const control of controls) {
      let group = result.find(([site]) => site === control.site);
      if (!group) result.push((group = [control.site, []]));
      group[1].push(control.label);
    }
    return result;
  });
</script>

<div style={`display:flex;flex-direction:column;gap:${gap}px;`}>
  {#each groups as [site, items] (site)}
    <div>
      <p class="offer-site">{site} Blocking Options</p>
      <ul class="offer-list">
        {#each items as item, index (index)}<li>{item}</li>{/each}
      </ul>
    </div>
  {/each}
</div>
