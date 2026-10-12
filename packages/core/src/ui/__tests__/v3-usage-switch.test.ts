import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import App from "../App.svelte";
import { STRINGS } from "../strings.js";
import { USAGE_SWITCH_COPY } from "../v3/usage-copy.js";
import { browser, capture, flush } from "./committed-popup-host.fixtures.js";

// ISS-0029 item 3 (owner, 12 Oct 2026; ADR 0004 "One usage-data control"): V3 builds have one
// usage-data control, the "Share usage data" switch with the V3 subtext. The default-on analytics
// hosts never ask for the one-time notice (default-on-analytics.test.ts, apple-default-on.test.ts),
// and the V3-only screens draw none. 2.x builds keep the 2.1 copy (the flags are unset elsewhere).
vi.mock("../../analytics/build-basis.js", () => ({ USAGE_ON_BY_DEFAULT_BUILD: true }));

beforeAll(async () => {
  await import("../v3/ExtensionSettings.svelte");
});

describe("V3 usage sharing: the switch is the one control", () => {
  it("keeps the 2.x switch title; only the subtext is new", () => {
    expect(USAGE_SWITCH_COPY.title).toBe(STRINGS.usage.title);
    expect(USAGE_SWITCH_COPY.body).not.toBe(STRINGS.usage.body);
  });

  it("the settings page shows one switch with the V3 subtext and no notice", async () => {
    await browser();
    const setSharing = vi.fn(async (enabled: boolean) => enabled);
    const state = capture({
      analytics: {
        track() {},
        identify() {},
        reset() {},
        // What the default-on Chrome host answers in V3: on, and no notice.
        sharing: async () => ({ enabled: true, noticeNeeded: false }),
        setSharing,
        acknowledgeNotice: vi.fn(),
      },
    });
    await flush();
    render(App, {
      controller: state.controller,
      committedPopupBinding: state.binding,
      settingsPresentation: {
        browser: "Chrome" as const,
        loadSettings: () => import("../v3/ExtensionSettings.svelte"),
        help: { onGuide: vi.fn(), onSupport: vi.fn(), onPrivacy: vi.fn() },
      },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "YouTube Blocker" })).toBeTruthy(),
    );
    const switches = screen.getAllByRole("switch", { name: USAGE_SWITCH_COPY.title });
    expect(switches).toHaveLength(1);
    expect(screen.getByText(USAGE_SWITCH_COPY.body)).toBeTruthy();
    expect(screen.queryByText(STRINGS.usage.body)).toBeNull();
    expect(screen.queryByText(STRINGS.usage.notice)).toBeNull();
    expect(screen.queryByRole("button", { name: STRINGS.usage.noticeTurnOff })).toBeNull();
    expect(screen.queryByRole("button", { name: STRINGS.usage.noticeOk })).toBeNull();
    // Help: the three links, without a heading or the support note (ISS-0029 item 8).
    expect(screen.queryByRole("heading", { name: "Help" })).toBeNull();
    expect(screen.queryByText(/Contact support opens your email app/)).toBeNull();
    for (const name of ["Setup guide", "Contact support", "Privacy policy"])
      expect(screen.getByRole("button", { name })).toBeTruthy();
    await fireEvent.click(switches[0]!);
    await waitFor(() => expect(state.controller.usageSharing).toBe(false));
    expect(setSharing).toHaveBeenCalledExactlyOnceWith(false);
  });
});
