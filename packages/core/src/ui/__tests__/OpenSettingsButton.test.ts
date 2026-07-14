import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import OpenSettingsButton from "../components/OpenSettingsButton.svelte";
import { SAFARI_SURFACE_GUIDANCE } from "../surface-guidance.js";

const VISIBLE_LABEL = "Open settings & setup guide";

describe("OpenSettingsButton", () => {
  it("starts the accessible name with the visible text (WCAG 2.5.3) and names the surface", async () => {
    const onOpen = vi.fn();
    render(OpenSettingsButton, {
      props: {
        surfaceGuidance: {
          title: "Find Still in a test browser",
          body: "Use this browser's extension menu.",
        },
        onOpen,
      },
    });

    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe(VISIBLE_LABEL);
    const name = button.getAttribute("aria-label") ?? "";
    expect(name.startsWith(VISIBLE_LABEL)).toBe(true);
    expect(name).toContain("Find Still in a test browser");
    await fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("keeps the Safari popup's label contract: visible text first, then the Safari title", () => {
    render(OpenSettingsButton, {
      props: { surfaceGuidance: SAFARI_SURFACE_GUIDANCE, onOpen: () => {} },
    });

    const name = screen.getByRole("button").getAttribute("aria-label") ?? "";
    expect(name.startsWith(VISIBLE_LABEL)).toBe(true);
    expect(name).toContain(SAFARI_SURFACE_GUIDANCE.title);
  });
});
