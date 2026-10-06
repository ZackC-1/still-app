// The Chrome/Firefox free-period "Restore purchase" link (owner decisions 62 and 73) exists only
// while the compiled paid flag is off. PAID_TIER_ENABLED is a literal in shared-types, so this file
// replaces that one export before the component loads (as apple-settings-host.paid-on.test.ts
// does) and checks that, with paid on and no paid producer supplied, the settings page shows no
// free-period link in its place.
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/svelte";

vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import { PAID_TIER_ENABLED } from "@still/shared-types";
import { fixture } from "./ExtensionSettings.test-fixtures.js";
import ExtensionSettings from "./ExtensionSettings.svelte";

describe("ExtensionSettings with the paid flag on", () => {
  it("shows no free-period Restore link, even with a Restore port", async () => {
    expect(PAID_TIER_ENABLED).toBe(true);
    const { props } = await fixture("locked");
    const { pro: _pro, ...free } = props;
    const onRestore = vi.fn();
    const view = render(ExtensionSettings, { props: { ...free, onRestore } });
    expect(screen.getByText("Still is active")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Restore purchase" })).toBeNull();
    expect(onRestore).not.toHaveBeenCalled();
    view.unmount();
  });
});
