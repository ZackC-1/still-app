import { describe, expect, expectTypeOf, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import FirstRun from "./FirstRun.svelte";
import type {
  FirstRunConsent,
  FirstRunProps,
} from "./first-run-presentation.js";
import type { OnboardingConsent } from "./apple-onboarding-presentation.js";

function fixture(): FirstRunProps {
  return {
    browser: "firefox",
    permission: {
      state: "needed",
      verified: true,
      requestVerified: true,
      onRequest: vi.fn(),
      guidance: {
        verified: true,
        text: "Private supplied permission guidance.",
      },
    },
    blocking: { state: "unknown", verified: false },
    pin: {
      pinned: false,
      verified: false,
      guidance: { verified: true, text: "Private supplied pin guidance." },
    },
    sync: { onSignIn: vi.fn() },
    consent: {
      status: "unasked",
      purposesVerified: true,
      purposes: [
        {
          name: "Private combined purpose",
          text: "Supplied email and usage purpose.",
        },
      ],
      onShare: vi.fn(),
      onDecline: vi.fn(),
    },
    settings: { verified: true, onOpen: vi.fn() },
    privacy: { verified: true, onOpen: vi.fn() },
  };
}

describe("controlled extension first-run", () => {
  it.each(["pending", "denied", "granted", "unknown"] as const)(
    "observes %s without inventing a grant after a request",
    async (state) => {
      const props = fixture();
      const view = render(FirstRun, { props });
      await fireEvent.click(screen.getByRole("button", { name: "Allow" }));
      expect(props.permission.onRequest).toHaveBeenCalledOnce();
      expect(screen.queryByText("Still is on.")).toBeNull();
      props.permission = { ...props.permission, state };
      await view.rerender(props);
      const request = screen.queryByRole("button", {
        name: state === "denied" ? "Try again" : "Allow",
      });
      if (request) await fireEvent.click(request);
      expect(props.permission.onRequest).toHaveBeenCalledTimes(
        state === "denied" ? 2 : 1,
      );
      expect(screen.queryByText("Still is on.")).toBeNull();
      view.unmount();
    },
  );
  it.each(["permission", "blocking", "off", "unknown"] as const)(
    "withholds working confirmation for %s uncertainty",
    (kind) => {
      const props = fixture();
      props.permission.state = "granted";
      props.blocking = { state: "on", verified: true };
      if (kind === "permission") props.permission.verified = false;
      if (kind === "blocking") props.blocking.verified = false;
      if (kind === "off") props.blocking.state = "off";
      if (kind === "unknown") props.blocking.state = "unknown";
      const view = render(FirstRun, { props });
      expect(screen.queryByText("Still is on.")).toBeNull();
      expect(screen.getByText("One step to finish setup.")).toBeVisible();
      view.unmount();
    },
  );
  it("confirms working only from both verified observations independently of sign-in and sharing", async () => {
    const props = fixture();
    props.permission.state = "granted";
    props.blocking = { state: "on", verified: true };
    props.consent = { status: "saved", choice: "off" };
    const view = render(FirstRun, { props });
    expect(screen.getByText("Still is on.")).toBeVisible();
    expect(
      screen.getByText("You chose not to share your email and usage data."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
    props.permission.state = "pending";
    await view.rerender(props);
    expect(
      screen.getByText("You chose not to share your email and usage data."),
    ).toBeVisible();
    expect(screen.queryByText("Still is on.")).toBeNull();
    view.unmount();
  });
  it("uses the current request callback and holds repeated requests as soon as pending", async () => {
    const props = fixture();
    const before = props.permission.onRequest;
    const after = vi.fn();
    const view = render(FirstRun, { props });
    props.permission = { ...props.permission, onRequest: after };
    await view.rerender(props);
    await fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(before).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledOnce();
    props.permission.state = "pending";
    await view.rerender(props);
    const held = screen.queryByRole("button", { name: "Allow" });
    if (held) await fireEvent.click(held);
    expect(after).toHaveBeenCalledOnce();
    expect(screen.getByText("Waiting for Firefox…")).toBeVisible();
    view.unmount();
  });
  it.each(["observation", "request", "callback"] as const)(
    "holds permission when %s authority is unavailable",
    async (kind) => {
      const props = fixture();
      if (kind === "observation") props.permission.verified = false;
      if (kind === "request") props.permission.requestVerified = false;
      if (kind === "callback") props.permission.onRequest = undefined;
      const view = render(FirstRun, { props });
      const action = screen.queryByRole("button", {
        name: "Allow",
      });
      if (action) await fireEvent.click(action);
      if (props.permission.onRequest)
        expect(props.permission.onRequest).not.toHaveBeenCalled();
      expect(screen.queryByText("Still is on.")).toBeNull();
      view.unmount();
    },
  );
  it("requires a verified Chrome pin observation and never claims Firefox pin completion", async () => {
    const props = fixture();
    props.browser = "chrome";
    props.pin.pinned = true;
    const view = render(FirstRun, { props });
    expect(screen.queryByText("Still is pinned.")).toBeNull();
    props.pin.verified = true;
    await view.rerender(props);
    expect(screen.getByText("Still is pinned.")).toBeVisible();
    props.browser = "firefox";
    await view.rerender(props);
    expect(screen.queryByText("Still is pinned.")).toBeNull();
    expect(screen.getByText("Private supplied pin guidance.")).toBeVisible();
    props.pin.guidance = { verified: false, text: "Unverified browser menu." };
    await view.rerender(props);
    expect(screen.queryByText("Unverified browser menu.")).toBeNull();
    view.unmount();
  });
  it.each(["absent", "unconfirmed", "empty"] as const)(
    "uses optional sign-in for %s session without a fake address or sync outcome",
    async (kind) => {
      const props = fixture();
      if (kind !== "absent")
        props.sync.account = {
          address: kind === "empty" ? "  " : "actual@fixture.test",
          confirmed: kind !== "unconfirmed",
        };
      const view = render(FirstRun, { props });
      await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      expect(props.sync.onSignIn).toHaveBeenCalledOnce();
      expect(screen.queryByText(/Signed in as/)).toBeNull();
      expect(
        screen.getByText(
          "Free. Keep your settings updated across every supported surface.",
        ),
      ).toBeVisible();
      view.unmount();
    },
  );
  it("renders only the caller-confirmed address and removes its sign-in request", () => {
    const props = fixture();
    props.sync.account = { address: "actual@fixture.test", confirmed: true };
    const view = render(FirstRun, { props });
    expect(screen.getByText("Signed in as actual@fixture.test.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    view.unmount();
  });
  it.each(["missing", "unverified", "empty"] as const)(
    "holds affirmative combined consent for %s purposes while decline remains independent",
    async (kind) => {
      const props = fixture();
      props.consent.purposesVerified = kind !== "unverified";
      if (kind !== "unverified")
        props.consent.purposes = kind === "empty" ? [] : undefined;
      const view = render(FirstRun, { props });
      await fireEvent.click(screen.getByRole("button", { name: "Share" }));
      await fireEvent.click(
        screen.getByRole("button", { name: "Don't share" }),
      );
      expect(props.consent.onShare).not.toHaveBeenCalled();
      expect(props.consent.onDecline).toHaveBeenCalledOnce();
      expect(screen.queryByText(/You chose/)).toBeNull();
      view.unmount();
    },
  );
  it("keeps equal choices controlled until actual acknowledgement and retains declined Off across setup changes", async () => {
    const props = fixture();
    const view = render(FirstRun, { props });
    const share = screen.getByRole("button", { name: "Share" }),
      decline = screen.getByRole("button", {
        name: "Don't share",
      });
    expect(share.className).toBe(decline.className);
    expect(screen.getByText("Supplied email and usage purpose.")).toBeVisible();
    await fireEvent.click(share);
    expect(props.consent.onShare).toHaveBeenCalledOnce();
    expect(screen.queryByText(/You chose/)).toBeNull();
    props.consent = { ...props.consent, status: "saved", choice: "off" };
    await view.rerender(props);
    expect(
      screen.getByText("You chose not to share your email and usage data."),
    ).toBeVisible();
    props.permission.state = "denied";
    await view.rerender(props);
    expect(
      screen.getByText("You chose not to share your email and usage data."),
    ).toBeVisible();
    expect(props.consent.onDecline).not.toHaveBeenCalled();
    view.unmount();
  });
  it("holds both consent callbacks while saving, displays supplied failure, and never acknowledges a failed choice", async () => {
    const props = fixture();
    props.consent = {
      ...props.consent,
      status: "saving",
      choice: "on",
      operation: { tone: "pending", text: "Actual saving observation." },
    };
    const view = render(FirstRun, { props });
    for (const name of ["Share", "Don't share"]) {
      const b = screen.getByRole("button", { name });
      await fireEvent.click(b);
    }
    expect(props.consent.onShare).not.toHaveBeenCalled();
    expect(props.consent.onDecline).not.toHaveBeenCalled();
    expect(screen.getByText("Actual saving observation.")).toBeVisible();
    expect(screen.queryByText(/You chose/)).toBeNull();
    props.consent = {
      ...props.consent,
      status: "failed",
      choice: "on",
      operation: { tone: "failed", text: "Actual failure observation." },
    };
    await view.rerender(props);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Actual failure observation.",
    );
    expect(screen.queryByText(/You chose/)).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Don't share" }));
    expect(props.consent.onDecline).toHaveBeenCalledOnce();
    view.unmount();
  });
  it("uses current verified footer destinations only", async () => {
    const props = fixture();
    const initial = props.settings.onOpen;
    const after = vi.fn();
    const view = render(FirstRun, { props });
    props.settings = { verified: true, onOpen: after };
    props.privacy.verified = false;
    await view.rerender(props);
    await fireEvent.click(
      screen.getByRole("button", { name: "Open Still settings" }),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: "Privacy policy" }),
    );
    expect(initial).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledOnce();
    expect(props.privacy.onOpen).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe("first-run consent contract", () => {
  it("is the Apple onboarding consent acknowledgement, not a parallel copy", () => {
    // Checked by the core typecheck: any divergence between the two contracts fails here.
    expectTypeOf<FirstRunConsent>().toEqualTypeOf<OnboardingConsent>();
    expectTypeOf<
      NonNullable<FirstRunProps["consent"]>
    >().toEqualTypeOf<OnboardingConsent>();
  });
});
