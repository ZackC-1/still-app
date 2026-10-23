import type { Page } from "@playwright/test";

/**
 * The Help card's links are link-sized (owner canvas, 22 Oct) with an invisible hit area drawn by a
 * ::before. Measures, in the page, each link's hit area along its centre line (elementFromPoint), and
 * every point on the visible labels and the support address that some other control would take.
 */
export async function helpHitAreas(page: Page): Promise<{
  heights: Record<string, number>;
  stolen: string[];
}> {
  return page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('section.help[aria-label="Help"]');
    if (!region) return { heights: {}, stolen: ["no Help card"] };
    // elementFromPoint sees only the viewport.
    region.scrollIntoView({ block: "center" });
    const links = [...region.querySelectorAll<HTMLElement>("button.link")].filter((el) => el.offsetParent);
    const address = region.querySelector<HTMLElement>(".support-address");
    const owns = (target: Element | null, el: HTMLElement) => !!target && (target === el || el.contains(target));
    const heights: Record<string, number> = {};
    for (const link of links) {
      const box = link.getBoundingClientRect();
      const x = box.left + box.width / 2;
      let top = Infinity;
      let bottom = -Infinity;
      for (let y = box.top - 30; y <= box.bottom + 30; y += 0.25) {
        if (owns(document.elementFromPoint(x, y), link)) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
      heights[link.textContent!.trim()] = bottom - top;
    }
    const stolen: string[] = [];
    for (const label of [...links, ...(address ? [address] : [])]) {
      const range = document.createRange();
      range.selectNodeContents(label);
      for (const rect of range.getClientRects()) {
        for (let y = rect.top + 0.5; y < rect.bottom; y += 0.5) {
          for (const x of [rect.left + 1, rect.left + rect.width / 2, rect.right - 1]) {
            const hit = document.elementFromPoint(x, y);
            if (!owns(hit, label)) {
              stolen.push(
                `${label.textContent!.trim()} at (${x.toFixed(1)}, ${y.toFixed(1)}) goes to ${hit?.textContent?.trim().slice(0, 30) ?? "nothing"}`,
              );
            }
          }
        }
      }
    }
    return { heights, stolen };
  });
}
