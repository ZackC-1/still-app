// ISS-0122, paid tier off (every shipped 2.x build): dormant Still Pro rows show the name and an
// inert Still Pro chip, never a switch, on every host. Cases: locked-row-no-switch.cases.ts.
import "@testing-library/jest-dom/vitest";
import { describe, vi } from "vitest";

// Pinned to the paid-off world: the 3.x release line compiles the paid tier on, and
// locked-row-no-switch.paid-on.test.ts covers that world.
vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: false,
}));
import { lockedRowWithoutSwitchCases } from "./locked-row-no-switch.cases.js";

describe("ISS-0122: locked rows without a switch (paid tier off)", () => {
  lockedRowWithoutSwitchCases(false);
});
