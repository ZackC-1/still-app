// ISS-0032 (reopened 15 Oct 2026) on the settings pages. The consistency rule: what the popups show
// for an account without Still Pro, the settings pages show too.
//  - Chrome/Firefox settings: a hold after a conclusive "locked" (a sync or setting change) keeps
//    the Still Pro card's Get Still Pro; verified ownership changes it.
//  - Safari settings (no price, no purchase; the Still app owns Still Pro): `proHandoff` shows the
//    same compact Still Pro card as the Safari popup and the lock chips open the app.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEATURE_REGISTRY, type AccessState, type BenefitAccessSnapshot } from "@still/shared-types";
import ExtensionSettings from "./ExtensionSettings.svelte";
import { fixture } from "./ExtensionSettings.test-fixtures.js";

// The Chrome/Firefox Get Still Pro is live only in builds compiled with the paid tier on (the QA
// sandbox build); this file replaces that one export before the components load.
vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

afterEach(cleanup);

function withPro(access: BenefitAccessSnapshot, state: AccessState): BenefitAccessSnapshot {
  const states = { ...access.states };
  for (const row of FEATURE_REGISTRY) if (row.tier === "pro") states[row.id] = state;
  return { ...access, states };
}

async function openYouTube() {
  const youtube = screen.getByRole("button", { name: "YouTube Blocker" });
  if (youtube.getAttribute("aria-expanded") !== "true") await fireEvent.click(youtube);
}

describe("Chrome/Firefox settings: the Still Pro card through a hold", () => {
  it("keeps the card and the lock chips while access is re-confirmed, without asking for money meanwhile", async () => {
    const { props } = await fixture("locked");
    props.pro = { ownership: "none", channel: "ready", offer: { price: "", checkoutPriced: true }, onSignIn: vi.fn(), onBuy: vi.fn() };
    props.sync.account = { confirmed: true };
    const view = render(ExtensionSettings, { props });
    await openYouTube();
    expect(within(screen.getByRole("region", { name: "Still Pro" })).getByRole("button", { name: "Get Still Pro" })).toBeEnabled();
    for (const held of ["verification_required", "checking"] as const) {
      await view.rerender({ ...props, access: withPro(props.access, held) });
      // The card stays (in its held state) and every Pro row keeps its lock: no switch appears.
      expect(screen.getByRole("region", { name: "Still Pro" })).toBeTruthy();
      expect(screen.getByRole("button", { name: /^Comments\. Included in Still Pro\./ })).toBeTruthy();
      expect(screen.queryByRole("switch", { name: "Comments" })).toBeNull();
      // Buying waits for the re-check (nothing asks for money while Still is unsure).
      expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    }
    await view.rerender({ ...props, access: withPro(props.access, "locked") });
    expect(within(screen.getByRole("region", { name: "Still Pro" })).getByRole("button", { name: "Get Still Pro" })).toBeEnabled();
    await view.rerender({ ...props, access: withPro(props.access, "purchased"), pro: { ...props.pro, ownership: "owned" } });
    expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Included in Still Pro/ })).toBeNull();
  });
});

describe("Safari settings: the Still app hand-off card (proHandoff)", () => {
  async function safari(state: AccessState) {
    const { props } = await fixture(state);
    const { pro: _pro, sharing: _sharing, ...rest } = props;
    const proHandoff = vi.fn();
    const view = render(ExtensionSettings, { props: { ...rest, proHandoff } });
    await openYouTube();
    return { view, proHandoff, props: { ...rest, proHandoff } };
  }

  it("locked: the popup's Still Pro card, opening the app; lock chips open it too; no price or purchase", async () => {
    const f = await safari("locked");
    const card = screen.getByRole("region", { name: "Still Pro" });
    expect(within(card).getByText("Even fewer distractions on Instagram, Facebook and YouTube. One-time purchase.")).toBeVisible();
    expect(within(card).getByText("Opens the Still app")).toBeVisible();
    await fireEvent.click(within(card).getByRole("button", { name: /Get Still Pro/ }));
    expect(f.proHandoff).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("button", { name: "Comments. Included in Still Pro. Open the Still app" }));
    expect(f.proHandoff).toHaveBeenCalledTimes(2);
    const text = document.body.textContent ?? "";
    for (const word of ["$", "Purchase", "Restore"]) expect(text).not.toContain(word);
  });

  it("stays through a hold, and goes on verified ownership", async () => {
    const f = await safari("locked");
    await f.view.rerender({ ...f.props, access: withPro(f.props.access, "verification_required") });
    expect(screen.getByRole("region", { name: "Still Pro" })).toBeTruthy();
    await f.view.rerender({ ...f.props, access: withPro(f.props.access, "purchased") });
    expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Included in Still Pro/ })).toBeNull();
  });

  it.each(["purchased", "unsupported"] as const)("%s: no Still Pro card and nothing opens the app", async (state) => {
    const f = await safari(state);
    expect(screen.queryByRole("region", { name: "Still Pro" })).toBeNull();
    expect(screen.queryByText("Opens the Still app")).toBeNull();
    // No live lock chip exists (purchased rows are switches; unsupported rows say so).
    expect(screen.queryByRole("button", { name: /Included in Still Pro\. Open the Still app$/ })).toBeNull();
    expect(screen.getAllByRole("switch").length).toBeGreaterThan(0);
    expect(f.proHandoff).not.toHaveBeenCalled();
  });

  it("checking: says so in the card's place, with no button", async () => {
    await safari("checking");
    expect(screen.getByText("Checking your Still Pro access…")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Get Still Pro/ })).toBeNull();
  });
});
