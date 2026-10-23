// The ISS-0122 cases, run once per paid world (see locked-row-hosts.fixtures.ts).
import { cleanup, fireEvent, screen, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { PAID_TIER_ENABLED } from "@still/shared-types";
import {
  LOCKED_ROW_HOSTS,
  eachOpenSite,
  expectLockedRowWithoutSwitch,
  lockedFixture,
  renderLockedHost,
} from "./locked-row-hosts.fixtures.js";

export function lockedRowWithoutSwitchCases(paidOn: boolean) {
  afterEach(cleanup);
  // Paid on, a person without Still Pro is "locked". Paid off, the packaged access answers
  // "unsupported" for every Still Pro row, which the hosts draw as the dormant locked row.
  const notOwned = paidOn ? "locked" : "unsupported";

  it(`compiles with the paid tier ${paidOn ? "on" : "off"}`, () => {
    expect(PAID_TIER_ENABLED).toBe(paidOn);
  });

  describe.each(LOCKED_ROW_HOSTS)("%s", (host) => {
    it.each([false, true])("signed in %s: every locked row is the name and the Still Pro chip, no switch", async (signedIn) => {
      const fixture = await lockedFixture(notOwned);
      const before = await fixture.storage.get();
      renderLockedHost(host, fixture, signedIn);
      let locked = 0;
      await eachOpenSite(async (panel) => {
        const rows = [...panel.querySelectorAll<HTMLElement>('.option-row[data-access="locked"]')];
        for (const row of rows) {
          expectLockedRowWithoutSwitch(row);
          // Paid off (decision 24) the chip is inert; paid on it is the row's only action.
          const chip = row.querySelector<HTMLElement>("button.lock-pro")!;
          if (!paidOn) expect(chip).toHaveAttribute("aria-disabled", "true");
          // Tapping anywhere on the row, the chip included, changes no saved choice.
          await fireEvent.click(row.querySelector(".label")!);
          await fireEvent.click(chip);
        }
        // The free row keeps its working switch: the only switch in each open site.
        expect(within(panel).getAllByRole("switch")).toHaveLength(1);
        locked += rows.length;
      });
      expect(locked).toBeGreaterThan(0);
      expect(fixture.onFeatureChange).not.toHaveBeenCalled();
      expect(await fixture.storage.get()).toEqual(before);
    });

    it("the saved choices apply again, unchanged, when Still Pro returns", async () => {
      const fixture = await lockedFixture(notOwned);
      const view = renderLockedHost(host, fixture, false);
      await fireEvent.click(screen.getByRole("button", { name: "YouTube Blocker" }));
      expect(screen.queryByRole("switch", { name: "Comments" })).toBeNull();
      await view.rerender({ access: fixture.accessFor("purchased") });
      const comments = screen.getByRole("switch", { name: "Comments" });
      expect(comments).toHaveAttribute("aria-checked", "true");
      expect(comments).not.toHaveAttribute("aria-disabled");
      expect(screen.queryByRole("button", { name: /Included in Still Pro/ })).toBeNull();
    });
  });
}
