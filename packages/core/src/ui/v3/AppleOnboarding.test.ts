import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import AppleOnboarding from "./AppleOnboarding.svelte";
import type { AppleOnboardingProps } from "./apple-onboarding-presentation.js";

function fixture(step: AppleOnboardingProps["step"] = 1): AppleOnboardingProps {
  return {
    step,
    platform: "ios",
    onBack: vi.fn(),
    onContinue: vi.fn(),
    onAssertEnabled: vi.fn(),
    onDoLater: vi.fn(),
    onOpenSafari: vi.fn(),
    onGoToSettings: vi.fn(),
    setup: {
      steps: ["Caller-approved actual instruction"],
      actionLabel: "Open actual host location",
      onOpen: vi.fn(),
    },
    consent: {
      status: "unasked",
      purposes: [
        {
          name: "Fixture verified combined disclosure",
          text: "Actual caller supplies approved purpose text",
        },
      ],
      purposesVerified: true,
      onShare: vi.fn(),
      onDecline: vi.fn(),
    },
  };
}

describe("controlled D12 Apple onboarding", () => {
  it("keeps navigation controlled and uses current action ports without account or purchase prerequisites", async () => {
    const props = fixture();
    const view = render(AppleOnboarding, { props });
    expect(screen.getByText("Free. No account needed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(props.onContinue).toHaveBeenCalledOnce();
    expect(screen.getByText("Step 1 of 4")).toBeTruthy();
    const replacement = vi.fn();
    props.onContinue = replacement;
    await view.rerender(props);
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(replacement).toHaveBeenCalledOnce();
    props.step = 2;
    await view.rerender(props);
    await fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(props.onBack).toHaveBeenCalledOnce();
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
    props.onBack = undefined;
    await view.rerender(props);
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    view.unmount();
  });

  it("renders only supplied setup wording and forwards iOS assertion separately from native confirmation", async () => {
    const props = fixture(2);
    props.detection = { state: "on", verified: true };
    const view = render(AppleOnboarding, { props });
    expect(screen.getByText("Caller-approved actual instruction")).toBeTruthy();
    expect(screen.queryByText("Still is on in Safari.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    await fireEvent.click(
      screen.getByRole("button", { name: "Open actual host location" }),
    );
    expect(props.setup!.onOpen).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: "I've turned it on" }),
    );
    expect(props.onAssertEnabled).toHaveBeenCalledOnce();
    expect(props.onContinue).not.toHaveBeenCalled();
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
    props.setup = undefined;
    props.onAssertEnabled = undefined;
    await view.rerender(props);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "I've turned it on" }),
    ).toBeDisabled();
    view.unmount();
  });

  it("uses only trusted Mac observations and keeps waiting, later and enabled Continue distinct", async () => {
    const props = fixture(2);
    props.platform = "mac";
    props.detection = { state: "on", verified: false };
    const view = render(AppleOnboarding, { props });
    expect(screen.queryByText("Still is on in Safari.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    props.detection = { state: "waiting", verified: true };
    await view.rerender(props);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for Still in Safari…",
    );
    await fireEvent.click(
      screen.getByRole("button", { name: "Do this later" }),
    );
    expect(props.onDoLater).toHaveBeenCalledOnce();
    expect(props.onContinue).not.toHaveBeenCalled();
    props.detection = { state: "on", verified: true };
    await view.rerender(props);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Still is on in Safari.",
    );
    expect(
      screen.queryByRole("button", { name: "Open actual host location" }),
    ).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(props.onContinue).toHaveBeenCalledOnce();
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
    view.unmount();
  });

  it("keeps equal combined consent actions and requires a supplied saved acknowledgement for Continue", async () => {
    const props = fixture(3);
    const view = render(AppleOnboarding, { props });
    const share = screen.getByRole("button", { name: "Share" });
    const decline = screen.getByRole("button", {
      name: "Don't share",
    });
    expect(share.className).toBe(decline.className);
    expect(
      screen.getByRole("heading", {
        name: "Share your email and usage data with Still?",
      }),
    ).toBeTruthy();
    await fireEvent.click(share);
    expect(props.consent.onShare).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("Saved. Change this any time in Settings."),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    await fireEvent.click(decline);
    expect(props.consent.onDecline).toHaveBeenCalledOnce();
    props.consent = { ...props.consent, status: "saved", choice: "off" };
    await view.rerender(props);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saved. Change this any time in Settings.",
    );
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(props.onContinue).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Share" }),
    ).toBeNull();
    view.unmount();
  });

  it.each(["unverified", "absent", "empty"] as const)(
    "withholds sharing for %s purposes and leaves explicit decline available",
    async (kind) => {
      const props = fixture(3);
      if (kind === "unverified") props.consent.purposesVerified = false;
      if (kind === "absent") props.consent.purposes = undefined;
      if (kind === "empty") props.consent.purposes = [];
      const view = render(AppleOnboarding, { props });
      await fireEvent.click(
        screen.getByRole("button", { name: "Share" }),
      );
      expect(props.consent.onShare).not.toHaveBeenCalled();
      await fireEvent.click(
        screen.getByRole("button", { name: "Don't share" }),
      );
      expect(props.consent.onDecline).toHaveBeenCalledOnce();
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
      view.unmount();
    },
  );

  it("refuses both repeated choices while saving and displays only current supplied failure without false completion", async () => {
    const props = fixture(3);
    const view = render(AppleOnboarding, { props });
    props.consent = {
      ...props.consent,
      status: "saving",
      choice: "on",
      operation: { tone: "pending", text: "Fixture actual request pending" },
    };
    await view.rerender(props);
    const share = screen.getByRole("button", { name: "Share" });
    const decline = screen.getByRole("button", { name: "Don't share" });
    await fireEvent.click(share);
    await fireEvent.click(decline);
    expect(props.consent.onShare).not.toHaveBeenCalled();
    expect(props.consent.onDecline).not.toHaveBeenCalled();
    expect(share).toHaveAttribute("aria-disabled", "true");
    expect(decline).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(
      screen.queryByText("Saved. Change this any time in Settings."),
    ).toBeNull();
    const retry = vi.fn();
    props.consent = {
      ...props.consent,
      status: "failed",
      operation: {
        tone: "failed",
        text: "Fixture request failed; saved choice retained",
        actionLabel: "Retry actual operation",
        onAction: retry,
      },
    };
    await view.rerender(props);
    expect(props.consent.choice).toBe("on");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Fixture request failed; saved choice retained",
    );
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    await fireEvent.click(
      screen.getByRole("button", { name: "Retry actual operation" }),
    );
    expect(retry).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("preserves the acknowledged device choice across caller-driven back-forward steps without automatic writes", async () => {
    const props = fixture(3);
    props.consent = { ...props.consent, status: "saved", choice: "off" };
    const view = render(AppleOnboarding, { props });
    for (const step of [2, 1, 2, 3] as const) {
      props.step = step;
      await view.rerender(props);
    }
    expect(
      screen.getByText("Saved. Change this any time in Settings."),
    ).toBeTruthy();
    expect(props.consent.choice).toBe("off");
    expect(props.consent.onShare).not.toHaveBeenCalled();
    expect(props.consent.onDecline).not.toHaveBeenCalled();
    props.consent = { ...props.consent, status: "saved", choice: "on" };
    await view.rerender(props);
    expect(props.consent.choice).toBe("on");
    view.unmount();
  });

  it("forwards account-free final host actions without changing supplied state and holds absent ports", async () => {
    const props = fixture(4);
    const view = render(AppleOnboarding, { props });
    await fireEvent.click(screen.getByRole("button", { name: "Open Safari" }));
    await fireEvent.click(
      screen.getByRole("button", { name: "Go to Settings" }),
    );
    expect(props.onOpenSafari).toHaveBeenCalledOnce();
    expect(props.onGoToSettings).toHaveBeenCalledOnce();
    expect(screen.getByText("Step 4 of 4")).toBeTruthy();
    expect(props.onContinue).not.toHaveBeenCalled();
    expect(props.consent.onShare).not.toHaveBeenCalled();
    props.onOpenSafari = undefined;
    props.onGoToSettings = undefined;
    await view.rerender(props);
    expect(screen.getByRole("button", { name: "Open Safari" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Go to Settings" }),
    ).toBeDisabled();
    view.unmount();
  });
});
