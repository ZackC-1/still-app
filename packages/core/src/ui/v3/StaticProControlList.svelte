<script lang="ts">
  let {
    controls,
    gap = 6,
  }: {
    controls: readonly { site: string; label: string }[];
    gap?: 6 | 10;
  } = $props();
  const SITE_ORDER = ["Instagram", "Facebook", "YouTube", "TikTok"];
  let groups = $derived.by(() => {
    const result: [string, string[]][] = [];
    for (const control of controls) {
      let group = result.find(([site]) => site === control.site);
      if (!group) result.push((group = [control.site, []]));
      group[1].push(control.label);
    }
    // Site order on every surface (owner, 12 Oct): Instagram, Facebook, YouTube, TikTok.
    // Presentation only; any other site keeps its place after them.
    const rank = (site: string) => {
      const index = SITE_ORDER.indexOf(site);
      return index === -1 ? SITE_ORDER.length : index;
    };
    return result.sort(([a], [b]) => rank(a) - rank(b));
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
