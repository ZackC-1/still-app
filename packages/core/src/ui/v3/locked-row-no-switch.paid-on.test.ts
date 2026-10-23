// ISS-0122, paid tier on (V3 Pro builds): a locked Still Pro row (never bought, or refunded) shows
// the name and the Still Pro chip, never a switch, on every host. The paid flag is replaced before
// the components load, as pro-entry.paid-on.test.ts does. Cases: locked-row-no-switch.cases.ts.
import "@testing-library/jest-dom/vitest";
import { describe, vi } from "vitest";

vi.mock("@still/shared-types", async (original) => ({
  ...(await original<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import { lockedRowWithoutSwitchCases } from "./locked-row-no-switch.cases.js";

describe("ISS-0122: locked rows without a switch (paid tier on)", () => {
  lockedRowWithoutSwitchCases(true);
});
