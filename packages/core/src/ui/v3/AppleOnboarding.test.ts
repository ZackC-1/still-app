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

// Retain the actual Svelte-installed listeners, including after their DOM nodes leave.
// The caller state uses Svelte's real reactive store bridge; no rerender/proxy invalidation.
import { mount, unmount, flushSync, tick } from "svelte";
import { writable, fromStore } from "svelte/store";

function mountedCurrent(initial: AppleOnboardingProps) {
  const store = writable(initial);
  const state = fromStore(store);
  const keys = [...new Set([...Object.keys(initial), "detection"])];
  const props = Object.fromEntries(
    keys.map((key) => [key, undefined]),
  ) as unknown as AppleOnboardingProps;
  for (const key of keys as (keyof AppleOnboardingProps)[]) {
    Object.defineProperty(props, key, { get: () => state.current[key] });
  }
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(AppleOnboarding, { target, props });
  flushSync();
  return {
    update(next: AppleOnboardingProps) {
      store.set(next);
    },
    retain(name: string) {
      const button = screen.getByRole("button", { name });
      const installed = button as unknown as Record<
        symbol,
        { click?: EventListener }
      >;
      const listener = Object.getOwnPropertySymbols(button)
        .filter((key) => key.description === "events")
        .map((key) => installed[key]?.click)
        .find((handler) => typeof handler === "function");
      expect(typeof listener).toBe("function");
      return () => listener!.call(button, new MouseEvent("click"));
    },
    async close() {
      await unmount(component);
      target.remove();
    },
  };
}

describe("D12 mounted current action authority", () => {
  it.each(["pending", "failed"] as const)(
    "keeps saved acknowledgement and %s supplied feedback independently visible",
    async (tone) => {
      const props = fixture(3);
      const action = vi.fn();
      props.consent = {
        ...props.consent,
        status: "saved",
        choice: "off",
        operation: {
          tone,
          text: "Caller operation outcome",
          detail: "Caller recovery detail",
          actionLabel: "Open help",
          onAction: action,
        },
      };
      const view = render(AppleOnboarding, { props });
      expect(
        screen.getByText("Saved. Change this any time in Settings."),
      ).toBeTruthy();
      const feedback = screen
        .getByText("Caller operation outcome")
        .closest("[role]");
      expect(feedback).toHaveAttribute(
        "role",
        tone === "failed" ? "alert" : "status",
      );
      expect(feedback).toHaveAttribute("data-tone", tone);
      expect(feedback).toHaveTextContent("Caller recovery detail");
      await fireEvent.click(screen.getByRole("button", { name: "Open help" }));
      expect(action).toHaveBeenCalledOnce();
      await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(props.onContinue).toHaveBeenCalledOnce();
      expect(props.consent.choice).toBe("off");
      expect(props.consent.onShare).not.toHaveBeenCalled();
      expect(props.consent.onDecline).not.toHaveBeenCalled();
      view.unmount();
    },
  );

  const transitions: {
    name: string;
    label: string;
    initial: (p: AppleOnboardingProps) => AppleOnboardingProps;
    next: (p: AppleOnboardingProps) => AppleOnboardingProps;
    port: (p: AppleOnboardingProps) => unknown;
  }[] = [
    {
      name: "Back leaves later steps",
      label: "Back",
      initial: (p) => ({ ...p, step: 2 }),
      next: (p) => ({ ...p, step: 1 }),
      port: (p) => p.onBack,
    },
    {
      name: "Continue leaves welcome",
      label: "Continue",
      initial: (p) => ({ ...p, step: 1 }),
      next: (p) => ({ ...p, step: 2 }),
      port: (p) => p.onContinue,
    },
    {
      name: "Continue loses verified Mac On",
      label: "Continue",
      initial: (p) => ({
        ...p,
        step: 2,
        platform: "mac",
        detection: { state: "on", verified: true },
      }),
      next: (p) => ({ ...p, detection: { state: "on", verified: false } }),
      port: (p) => p.onContinue,
    },
    {
      name: "Continue loses saved acknowledgement",
      label: "Continue",
      initial: (p) => ({
        ...p,
        step: 3,
        consent: { ...p.consent, status: "saved", choice: "off" },
      }),
      next: (p) => ({ ...p, consent: { ...p.consent, status: "saving" } }),
      port: (p) => p.onContinue,
    },
    {
      name: "setup reaches verified Mac On",
      label: "Open actual host location",
      initial: (p) => ({ ...p, step: 2, platform: "mac" }),
      next: (p) => ({ ...p, detection: { state: "on", verified: true } }),
      port: (p) => p.setup!.onOpen,
    },
    {
      name: "setup leaves step two",
      label: "Open actual host location",
      initial: (p) => ({ ...p, step: 2 }),
      next: (p) => ({ ...p, step: 3 }),
      port: (p) => p.setup!.onOpen,
    },
    {
      name: "iOS assertion becomes Mac",
      label: "I've turned it on",
      initial: (p) => ({ ...p, step: 2 }),
      next: (p) => ({ ...p, platform: "mac" }),
      port: (p) => p.onAssertEnabled,
    },
    {
      name: "iOS assertion leaves step two",
      label: "I've turned it on",
      initial: (p) => ({ ...p, step: 2 }),
      next: (p) => ({ ...p, step: 4 }),
      port: (p) => p.onAssertEnabled,
    },
    {
      name: "Do later becomes iOS",
      label: "Do this later",
      initial: (p) => ({ ...p, step: 2, platform: "mac" }),
      next: (p) => ({ ...p, platform: "ios" }),
      port: (p) => p.onDoLater,
    },
    {
      name: "Do later reaches verified Mac On",
      label: "Do this later",
      initial: (p) => ({ ...p, step: 2, platform: "mac" }),
      next: (p) => ({ ...p, detection: { state: "on", verified: true } }),
      port: (p) => p.onDoLater,
    },
    {
      name: "Open Safari leaves final step",
      label: "Open Safari",
      initial: (p) => ({ ...p, step: 4 }),
      next: (p) => ({ ...p, step: 1 }),
      port: (p) => p.onOpenSafari,
    },
    {
      name: "Go Settings leaves final step",
      label: "Go to Settings",
      initial: (p) => ({ ...p, step: 4 }),
      next: (p) => ({ ...p, step: 2 }),
      port: (p) => p.onGoToSettings,
    },
    {
      name: "Share leaves consent",
      label: "Share",
      initial: (p) => ({ ...p, step: 3 }),
      next: (p) => ({ ...p, step: 4 }),
      port: (p) => p.consent.onShare,
    },
    {
      name: "Share loses disclosure verification",
      label: "Share",
      initial: (p) => ({ ...p, step: 3 }),
      next: (p) => ({
        ...p,
        consent: { ...p.consent, purposesVerified: false },
      }),
      port: (p) => p.consent.onShare,
    },
    {
      name: "Share loses disclosure purposes",
      label: "Share",
      initial: (p) => ({ ...p, step: 3 }),
      next: (p) => ({ ...p, consent: { ...p.consent, purposes: [] } }),
      port: (p) => p.consent.onShare,
    },
    {
      name: "Decline leaves consent",
      label: "Don't share",
      initial: (p) => ({ ...p, step: 3 }),
      next: (p) => ({ ...p, step: 2 }),
      port: (p) => p.consent.onDecline,
    },
    {
      name: "Share starts saving",
      label: "Share",
      initial: (p) => ({ ...p, step: 3 }),
      next: (p) => ({ ...p, consent: { ...p.consent, status: "saving" } }),
      port: (p) => p.consent.onShare,
    },
    {
      name: "Decline becomes saved",
      label: "Don't share",
      initial: (p) => ({ ...p, step: 3 }),
      next: (p) => ({
        ...p,
        consent: { ...p.consent, status: "saved", choice: "off" },
      }),
      port: (p) => p.consent.onDecline,
    },
    {
      name: "generic action leaves consent",
      label: "Open help",
      initial: (p) => ({
        ...p,
        step: 3,
        consent: {
          ...p.consent,
          operation: {
            tone: "info",
            text: "Actual help",
            actionLabel: "Open help",
            onAction: vi.fn(),
          },
        },
      }),
      next: (p) => ({ ...p, step: 4 }),
      port: (p) => p.consent.operation!.onAction,
    },
  ];
  it.each(transitions)(
    "retained actual listener: $name before and after DOM flush",
    async ({ label, initial, next, port }) => {
      const props = initial(fixture());
      const view = mountedCurrent(props);
      try {
        const retained = view.retain(label);
        retained();
        expect(port(props)).toHaveBeenCalledOnce();
        vi.mocked(port(props) as () => void).mockClear();
        view.update(next(props));
        // Store property delivery is synchronous; the old DOM is still present here.
        expect(screen.getByRole("button", { name: label })).toBeTruthy();
        retained();
        expect(port(props)).not.toHaveBeenCalled();
        await tick();
        retained();
        expect(port(props)).not.toHaveBeenCalled();
      } finally {
        await view.close();
      }
    },
  );

  it.each(
    transitions.filter(
      (item, index, all) =>
        all.findIndex((other) => other.label === item.label) === index,
    ),
  )(
    "current replacement, removal and unmount: $label",
    async ({ label, initial, port }) => {
      const props = initial(fixture());
      const replacement = initial(fixture());
      const view = mountedCurrent(props);
      const retained = view.retain(label);
      try {
        view.update(replacement);
        retained();
        expect(port(replacement)).toHaveBeenCalledOnce();
        expect(port(props)).not.toHaveBeenCalled();
        await tick();
        retained();
        expect(port(replacement)).toHaveBeenCalledTimes(2);
        const absent = {
          ...replacement,
          onBack: undefined,
          onContinue: undefined,
          onAssertEnabled: undefined,
          onDoLater: undefined,
          onOpenSafari: undefined,
          onGoToSettings: undefined,
          setup: undefined,
          consent: {
            ...replacement.consent,
            onShare: undefined,
            onDecline: undefined,
            operation: undefined,
          },
        };
        view.update(absent);
        retained();
        expect(port(replacement)).toHaveBeenCalledTimes(2);
        await tick();
        retained();
        expect(port(replacement)).toHaveBeenCalledTimes(2);
        view.update(replacement);
        await tick();
      } finally {
        await view.close();
      }
      retained();
      expect(port(replacement)).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps generic help/cancel current during saving without inferring retry semantics", async () => {
    const props = fixture(3);
    const help = vi.fn(),
      cancel = vi.fn();
    props.consent = {
      ...props.consent,
      status: "saving",
      operation: {
        tone: "pending",
        text: "Actual pending request",
        actionLabel: "Retry",
        onAction: help,
      },
    };
    const view = mountedCurrent(props);
    try {
      const retained = view.retain("Retry");
      retained();
      expect(help).toHaveBeenCalledOnce();
      view.update({
        ...props,
        consent: {
          ...props.consent,
          operation: { ...props.consent.operation!, onAction: cancel },
        },
      });
      retained();
      expect(cancel).toHaveBeenCalledOnce();
      await tick();
      retained();
      expect(cancel).toHaveBeenCalledTimes(2);
      view.update({
        ...props,
        consent: { ...props.consent, operation: undefined },
      });
      retained();
      expect(help).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledTimes(2);
    } finally {
      await view.close();
    }
  });
});
