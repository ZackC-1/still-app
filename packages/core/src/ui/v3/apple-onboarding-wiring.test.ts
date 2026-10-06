import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, waitFor, within } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NativeBridge,
  openNativeDestination,
  type NativeOpenDestination,
  type SafariSetupObservation,
} from "../../native/bridge.js";
import type { StillBridgeWindow } from "../../storage/wkwebview-adapter.js";
import {
  createAppleOnboardingHost,
  runAppleOnboardingFirst,
  type AppleOnboardingHostBridge,
  type AppleOnboardingScreens,
} from "./apple-onboarding-host.js";

// H2b: the D12 onboarding wired into the Apple app's web view (packages/app-webview), driven
// through the real entry module over a real NativeBridge and a router-shaped native host.

const APP_WEBVIEW = resolve(import.meta.dirname, "../../../../app-webview/src");
const WIRING_PATH = resolve(APP_WEBVIEW, "apple-onboarding.ts");
const MAIN_PATH = resolve(APP_WEBVIEW, "main.ts");
const GATE_SWIFT = resolve(
  import.meta.dirname,
  "../../../../../apps/apple/StillKit/Sources/StillKit/OnboardingGatePresenter.swift",
);

type Presenter = "swiftui" | "web";

/** WebBridgeRouter + OnboardingGate (OnboardingGatePresenter.swift), as the web view sees them.
 * `nativePresents()` mirrors `OnboardingGate.nativeInitialStep`: the SwiftUI flow presents only
 * while it is the presenter and the gate is incomplete. */
function fakeAppleHost(options: {
  presenter?: Presenter;
  completed?: boolean;
  platform?: "ios" | "macos";
  osMajorVersion?: number;
  extensionStatus?: "enabled" | "disabled" | "unknown";
}) {
  const native = {
    presenter: options.presenter ?? "web",
    completed: options.completed ?? false,
    platform: options.platform ?? "ios",
    osMajorVersion: options.osMajorVersion ?? 18,
    extensionStatus: options.extensionStatus ?? "unknown",
    /** Replace the onboardingState reply (malformed, never). */
    stateReply: undefined as (() => Promise<unknown>) | undefined,
    /** Replace the completeOnboarding reply (refusal, delay). */
    completeReply: undefined as (() => Promise<unknown>) | undefined,
    /** Destinations native opened, in order. */
    opened: [] as string[],
  };
  const port = {
    postMessage: vi.fn(async (message: unknown): Promise<unknown> => {
      const { kind } = message as { kind: string };
      if (kind === "onboardingState") {
        if (native.stateReply) return native.stateReply();
        return JSON.stringify({
          ok: true,
          shouldShow: native.presenter === "web" && !native.completed,
          platform: native.platform,
          osMajorVersion: native.osMajorVersion,
        });
      }
      if (kind === "completeOnboarding") {
        if (native.completeReply) return native.completeReply();
        if (native.presenter !== "web")
          throw new Error("still: onboarding not presented by the web view");
        native.completed = true;
        return JSON.stringify({ ok: true });
      }
      if (kind === "openDestination") {
        // NativeOpenRequest.authorize: exactly two keys, a fixed destination this platform opens.
        const body = message as Record<string, unknown>;
        const supported =
          native.platform === "macos" ? ["safariExtensionSettings", "safari"] : ["settingsAppStillPage"];
        if (Object.keys(body).length !== 2 || !supported.includes(body.destination as string))
          throw new Error("still: open refused (unsupported)");
        native.opened.push(body.destination as string);
        return JSON.stringify({ ok: true, destination: body.destination });
      }
      if (kind === "safariSetupState") {
        return JSON.stringify(
          native.platform === "ios"
            ? { ok: true, platform: "ios", extensionStatus: native.extensionStatus, enableLocation: "settingsAppStillPage" }
            : { ok: true, platform: "macos", extensionStatus: native.extensionStatus, enableLocation: "safariExtensionSettings" },
        );
      }
      throw new Error(`unexpected native message ${kind}`);
    }),
  };
  const win: StillBridgeWindow = { webkit: { messageHandlers: { still: port } } };
  return {
    native,
    port,
    bridge: new NativeBridge(win),
    /** The real fixed-destination opener over this host (a tap is assumed; jsdom has no
     * userActivation). */
    open: (destination: NativeOpenDestination) =>
      openNativeDestination(destination, { win, userActivation: null }),
    kinds: () => port.postMessage.mock.calls.map(([m]) => (m as { kind: string }).kind),
    nativePresents: () => native.presenter === "swiftui" && !native.completed,
  };
}

/** The app-webview module's shape (loaded by path, so core's program never includes its source). */
interface Wiring {
  showAppleOnboardingFirst(wiring: {
    bridge: Pick<NativeBridge, "onboardingState" | "completeOnboarding" | "observeSafariSetup">;
    target: HTMLElement;
    showSettings: () => void;
    open?: (destination: NativeOpenDestination) => Promise<boolean>;
  }): Promise<"onboarding" | "settings">;
  D12_WEB_ONBOARDING_MARKER: string;
}

const targets: HTMLElement[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const target of targets.splice(0)) target.remove();
});

/** Runs the real app-webview wiring into a fresh mount point. */
async function launch(
  bridge: Pick<NativeBridge, "onboardingState" | "completeOnboarding" | "observeSafariSetup">,
  open?: (destination: NativeOpenDestination) => Promise<boolean>,
) {
  const { showAppleOnboardingFirst } = (await import(/* @vite-ignore */ WIRING_PATH)) as Wiring;
  const target = document.createElement("div");
  document.body.append(target);
  targets.push(target);
  const showSettings = vi.fn(() => {
    const settings = document.createElement("p");
    settings.textContent = "SETTINGS SCREEN";
    target.append(settings);
  });
  const result = await showAppleOnboardingFirst({ bridge, target, showSettings, open });
  return { result, target, view: within(target), showSettings };
}

const onboardingShown = (target: HTMLElement): boolean =>
  within(target).queryByRole("heading", { name: "Welcome to Still" }) !== null ||
  target.querySelector("main.ob") !== null;

describe("one gate, one presenter", () => {
  it.each([
    ["swiftui", false],
    ["swiftui", true],
    ["web", false],
    ["web", true],
  ] as const)("presenter=%s completed=%s: never both onboarding presentations", async (presenter, completed) => {
    const app = fakeAppleHost({ presenter, completed });
    const { target, showSettings } = await launch(app.bridge);
    const webShows = onboardingShown(target);
    expect(webShows && app.nativePresents()).toBe(false);
    // Exactly one screen in the web view: onboarding or settings.
    expect(webShows).toBe(presenter === "web" && !completed);
    expect(showSettings).toHaveBeenCalledTimes(webShows ? 0 : 1);
  });

  it("the native contract the fake mirrors is the one in OnboardingGatePresenter.swift", () => {
    const swift = readFileSync(GATE_SWIFT, "utf8");
    expect(swift).toMatch(/guard presenter == \.swiftUI else \{ return nil \}/);
    expect(swift).toMatch(/presenter == \.web && shouldShow\(defaults\)/);
    expect(swift).toMatch(/guard presenter == \.web else \{ return false \}/);
  });

  it.each([
    ["no native host", () => Promise.resolve(null)],
    ["a malformed reply", () => Promise.resolve(JSON.stringify({ ok: true, shouldShow: "true", platform: "ios", osMajorVersion: 18 }))],
    ["a refused read", () => Promise.reject(new Error("still: refused"))],
  ] as const)("%s mounts settings and never shows onboarding", async (_name, reply) => {
    const app = fakeAppleHost({ presenter: "web" });
    app.native.stateReply = reply;
    const { target, showSettings } = await launch(app.bridge);
    expect(onboardingShown(target)).toBe(false);
    expect(showSettings).toHaveBeenCalledOnce();
    expect(app.kinds()).not.toContain("completeOnboarding");
    expect(app.native.completed).toBe(false);
  });

  it("a native host that never answers is bounded: settings mount after the deadline", async () => {
    vi.useFakeTimers();
    const app = fakeAppleHost({ presenter: "web" });
    app.native.stateReply = () => new Promise<unknown>(() => {});
    const pending = launch(app.bridge);
    await vi.advanceTimersByTimeAsync(3_000);
    const { target, showSettings, result } = await pending;
    expect(result).toBe("settings");
    expect(onboardingShown(target)).toBe(false);
    expect(showSettings).toHaveBeenCalledOnce();
  });

  it("outside the app (no webkit port) mounts settings directly", async () => {
    const { target, showSettings } = await launch(new NativeBridge({}));
    expect(onboardingShown(target)).toBe(false);
    expect(showSettings).toHaveBeenCalledOnce();
  });
});

describe("the D12 flow in the web view", () => {
  it("iOS 18: three steps, no consent question, completion only through the native gate", async () => {
    const app = fakeAppleHost({ presenter: "web", platform: "ios", osMajorVersion: 18 });
    const { target, view, showSettings, result } = await launch(app.bridge, app.open);
    expect(result).toBe("onboarding");
    expect(view.getByRole("heading", { name: "Welcome to Still" })).toBeInTheDocument();
    expect(view.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(showSettings).not.toHaveBeenCalled();

    await fireEvent.click(view.getByRole("button", { name: "Continue" }));
    await view.findByRole("heading", { name: "Turn on Still in Safari" });
    for (const line of [
      "Open the Settings app.",
      "Go to Apps, then Safari, then Extensions.",
      "Turn on Still and allow it on every website.",
    ])
      expect(view.getByText(line)).toBeInTheDocument();
    // "Open Settings" opens Still's page in the Settings app through the fixed native destination.
    await fireEvent.click(view.getByRole("button", { name: "Open Settings" }));
    await waitFor(() => expect(app.native.opened).toEqual(["settingsAppStillPage"]));
    await waitFor(() => expect(app.kinds()).toContain("safariSetupState"));
    expect(view.queryByText("Still is on in Safari.")).toBeNull();

    await fireEvent.click(view.getByRole("button", { name: "I've turned it on" }));
    await view.findByRole("heading", { name: "You're set" });
    expect(view.getByText("Step 3 of 3")).toBeInTheDocument();
    expect(view.queryByRole("heading", { name: "Help improve Still?" })).toBeNull();
    // iOS has no public way to open Safari itself, so the button never pretends to.
    expect(view.getByRole("button", { name: "Open Safari" })).toBeDisabled();
    expect(app.native.completed).toBe(false);

    await fireEvent.click(view.getByRole("button", { name: "Go to Settings" }));
    await waitFor(() => expect(showSettings).toHaveBeenCalledOnce());
    expect(app.native.completed).toBe(true);
    expect(app.kinds().filter((k) => k === "completeOnboarding")).toHaveLength(1);
    expect(onboardingShown(target)).toBe(false);
    expect(view.getByText("SETTINGS SCREEN")).toBeInTheDocument();
    // Nothing about sharing was ever sent, and nothing but Settings was opened.
    expect(
      app.kinds().every((k) =>
        ["onboardingState", "safariSetupState", "openDestination", "completeOnboarding"].includes(k),
      ),
    ).toBe(true);
    expect(app.native.opened).toEqual(["settingsAppStillPage"]);

    // The next launch (or a web content reload) goes straight to settings: no loop.
    const again = await launch(app.bridge);
    expect(again.result).toBe("settings");
    expect(onboardingShown(again.target)).toBe(false);
  });

  it("iOS 15-17 use the approved older Settings path", async () => {
    const app = fakeAppleHost({ presenter: "web", platform: "ios", osMajorVersion: 17 });
    const { view } = await launch(app.bridge);
    await fireEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(await view.findByText("Go to Safari, then Extensions.")).toBeInTheDocument();
  });

  it("settings never mount before the native gate confirms; a failure keeps onboarding with retry", async () => {
    const app = fakeAppleHost({ presenter: "web" });
    let confirm!: (reply: unknown) => void;
    app.native.completeReply = () => Promise.reject(new Error("still: write failed"));
    const { target, view, showSettings } = await launch(app.bridge);
    await fireEvent.click(view.getByRole("button", { name: "Continue" }));
    await fireEvent.click(await view.findByRole("button", { name: "I've turned it on" }));
    await fireEvent.click(await view.findByRole("button", { name: "Go to Settings" }));
    expect(await view.findByText("We couldn't finish setup.")).toBeInTheDocument();
    expect(showSettings).not.toHaveBeenCalled();
    expect(onboardingShown(target)).toBe(true);

    app.native.completeReply = () =>
      new Promise<unknown>((resolve) => {
        confirm = resolve;
      });
    await fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(confirm).toBeTypeOf("function"));
    await new Promise((r) => setTimeout(r, 0));
    expect(showSettings).not.toHaveBeenCalled();
    expect(onboardingShown(target)).toBe(true);
    app.native.completed = true;
    confirm(JSON.stringify({ ok: true }));
    await waitFor(() => expect(showSettings).toHaveBeenCalledOnce());
    expect(onboardingShown(target)).toBe(false);
  });

  it("macOS shows Still as on only from a positive native signal, re-read on focus", async () => {
    const app = fakeAppleHost({ presenter: "web", platform: "macos", osMajorVersion: 15, extensionStatus: "disabled" });
    const { view } = await launch(app.bridge, app.open);
    await fireEvent.click(view.getByRole("button", { name: "Continue" }));
    await view.findByRole("heading", { name: "Turn on Still in Safari" });
    for (const line of ["Open Safari, then Settings, then Extensions.", "Turn on Still.", "Allow it on every website."])
      expect(view.getByText(line)).toBeInTheDocument();
    await waitFor(() => expect(app.kinds()).toContain("safariSetupState"));
    expect(view.queryByText("Still is on in Safari.")).toBeNull();
    expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Open Safari Settings" }));
    await waitFor(() => expect(app.native.opened).toEqual(["safariExtensionSettings"]));

    app.native.extensionStatus = "unknown";
    window.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 0));
    expect(view.queryByText("Still is on in Safari.")).toBeNull();

    app.native.extensionStatus = "enabled";
    window.dispatchEvent(new Event("focus"));
    expect(await view.findByText("Still is on in Safari.")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("iOS never claims Still is enabled, even from a forged or mismatched observation", async () => {
    const forged: SafariSetupObservation[] = [
      { ok: true, platform: "ios", extensionStatus: "enabled", enableLocation: "settingsAppStillPage" } as unknown as SafariSetupObservation,
      { ok: true, platform: "macos", extensionStatus: "enabled", enableLocation: "safariExtensionSettings" },
    ];
    for (const observation of forged) {
      const app = fakeAppleHost({ presenter: "web", platform: "ios" });
      const bridge = {
        onboardingState: () => app.bridge.onboardingState(),
        completeOnboarding: () => app.bridge.completeOnboarding(),
        observeSafariSetup: vi.fn(async () => observation),
      };
      const { view } = await launch(bridge);
      await fireEvent.click(view.getByRole("button", { name: "Continue" }));
      await view.findByRole("heading", { name: "Turn on Still in Safari" });
      await waitFor(() => expect(bridge.observeSafariSetup).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(view.queryByText("Still is on in Safari.")).toBeNull();
      expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
    }
    // The host itself never reports iOS as on, nor lets Continue skip the iOS assertion.
    for (const observation of forged) {
      const host = createAppleOnboardingHost({
        bridge: {
          onboardingState: async () => ({ ok: true, shouldShow: true, platform: "ios", osMajorVersion: 18 }),
          completeOnboarding: async () => true,
          observeSafariSetup: async () => observation,
        },
        consent: { purposesVerified: false },
        onDone: vi.fn(),
      });
      await host.start();
      const props = () => (host.view.visible ? host.view.props : undefined)!;
      props().onContinue?.();
      await new Promise((r) => setTimeout(r, 0));
      expect(props().step).toBe(2);
      expect(props().detection).toBeUndefined();
      props().onContinue?.();
      expect(props().step).toBe(2);
      host.dispose();
    }
    // And the real bridge drops an iOS "enabled" reply outright.
    const app = fakeAppleHost({ presenter: "web", platform: "ios", extensionStatus: "enabled" });
    expect(await app.bridge.observeSafariSetup()).toBeNull();
  });
});

describe("fixed native destinations", () => {
  it("macOS: Open Safari completes the native gate, then opens Safari, then mounts settings", async () => {
    const app = fakeAppleHost({ presenter: "web", platform: "macos", osMajorVersion: 15, extensionStatus: "enabled" });
    const { target, view, showSettings } = await launch(app.bridge, app.open);
    await fireEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(await view.findByText("Still is on in Safari.")).toBeInTheDocument();
    await fireEvent.click(view.getByRole("button", { name: "Continue" }));
    await view.findByRole("heading", { name: "You're set" });
    await fireEvent.click(view.getByRole("button", { name: "Open Safari" }));
    await waitFor(() => expect(showSettings).toHaveBeenCalledOnce());
    await waitFor(() => expect(app.native.opened).toEqual(["safari"]));
    const kinds = app.kinds();
    expect(kinds.indexOf("completeOnboarding")).toBeLessThan(kinds.indexOf("openDestination"));
    expect(app.native.completed).toBe(true);
    expect(onboardingShown(target)).toBe(false);
  });

  it("an open that native refuses or that fails leaves onboarding usable", async () => {
    const app = fakeAppleHost({ presenter: "web", platform: "ios" });
    const refused = vi.fn(async () => false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { view } = await launch(app.bridge, refused);
      await fireEvent.click(view.getByRole("button", { name: "Continue" }));
      await fireEvent.click(await view.findByRole("button", { name: "Open Settings" }));
      expect(refused).toHaveBeenCalledExactlyOnceWith("settingsAppStillPage");
      expect(view.getByRole("button", { name: "I've turned it on" })).toBeEnabled();
      // Not silently lost: a developer-console trace, no user-facing copy.
      await waitFor(() =>
        expect(warn).toHaveBeenCalledExactlyOnceWith("still: could not open settingsAppStillPage"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("macOS: an Open Safari that native refuses still mounts settings and leaves a console trace", async () => {
    const app = fakeAppleHost({ presenter: "web", platform: "macos", osMajorVersion: 15, extensionStatus: "enabled" });
    const refused = vi.fn(async () => false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { view, showSettings } = await launch(app.bridge, refused);
      await fireEvent.click(view.getByRole("button", { name: "Continue" }));
      await view.findByText("Still is on in Safari.");
      await fireEvent.click(view.getByRole("button", { name: "Continue" }));
      await fireEvent.click(await view.findByRole("button", { name: "Open Safari" }));
      await waitFor(() => expect(showSettings).toHaveBeenCalledOnce());
      expect(refused).toHaveBeenCalledExactlyOnceWith("safari");
      await waitFor(() => expect(warn).toHaveBeenCalledExactlyOnceWith("still: could not open safari"));
    } finally {
      warn.mockRestore();
    }
  });

  it("the real opener is used by default and posts nothing outside the app", async () => {
    const app = fakeAppleHost({ presenter: "web", platform: "ios" });
    const { view } = await launch(app.bridge);
    await fireEvent.click(view.getByRole("button", { name: "Continue" }));
    await fireEvent.click(await view.findByRole("button", { name: "Open Settings" }));
    await new Promise((r) => setTimeout(r, 0));
    // jsdom's own window has no webkit port, so the default opener never reached this host.
    expect(app.kinds()).not.toContain("openDestination");
  });

  it("marks its mount point with the D12 marker the native presenter switch looks for", async () => {
    const { D12_WEB_ONBOARDING_MARKER } = (await import(/* @vite-ignore */ WIRING_PATH)) as Wiring;
    expect(D12_WEB_ONBOARDING_MARKER).toBe("still-onboarding-presenter:web-d12");
    const swift = readFileSync(GATE_SWIFT, "utf8");
    expect(swift).toContain(`public static let webD12Marker = "${D12_WEB_ONBOARDING_MARKER}"`);
    const app = fakeAppleHost({ presenter: "web", completed: true });
    const { target } = await launch(app.bridge);
    expect(target.getAttribute("data-still-onboarding")).toBe(D12_WEB_ONBOARDING_MARKER);
  });
});

// #282 review P3-4: a reply that arrives after the 3 s deadline.
describe("a late native reply", () => {
  it("an onboardingState reply after the deadline never shows onboarding over settings", async () => {
    vi.useFakeTimers();
    const app = fakeAppleHost({ presenter: "web" });
    let answer!: (reply: unknown) => void;
    app.native.stateReply = () =>
      new Promise<unknown>((resolve) => {
        answer = resolve;
      });
    const pending = launch(app.bridge, app.open);
    await vi.advanceTimersByTimeAsync(3_000);
    const { target, showSettings, result } = await pending;
    expect(result).toBe("settings");
    answer(JSON.stringify({ ok: true, shouldShow: true, platform: "ios", osMajorVersion: 18 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(onboardingShown(target)).toBe(false);
    expect(showSettings).toHaveBeenCalledOnce();
    expect(app.kinds()).not.toContain("completeOnboarding");
    expect(app.native.completed).toBe(false);
  });

  it("a completeOnboarding reply after the deadline keeps the failure line and mounts nothing", async () => {
    const app = fakeAppleHost({ presenter: "web", platform: "ios" });
    const { target, view, showSettings } = await launch(app.bridge, app.open);
    await fireEvent.click(view.getByRole("button", { name: "Continue" }));
    await fireEvent.click(await view.findByRole("button", { name: "I've turned it on" }));
    const done = await view.findByRole("button", { name: "Go to Settings" });
    vi.useFakeTimers();
    let confirm!: (reply: unknown) => void;
    app.native.completeReply = () =>
      new Promise<unknown>((resolve) => {
        confirm = resolve;
      });
    await fireEvent.click(done);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(view.getByText("We couldn't finish setup.")).toBeInTheDocument();
    app.native.completed = true;
    confirm(JSON.stringify({ ok: true }));
    await vi.advanceTimersByTimeAsync(10);
    expect(view.getByText("We couldn't finish setup.")).toBeInTheDocument();
    expect(showSettings).not.toHaveBeenCalled();
    expect(onboardingShown(target)).toBe(true);
  });
});

describe("runAppleOnboardingFirst", () => {
  function bridge(shouldShow: boolean, complete = true): AppleOnboardingHostBridge {
    return {
      onboardingState: async () => ({ ok: true, shouldShow, platform: "ios", osMajorVersion: 18 }),
      completeOnboarding: async () => complete,
      observeSafariSetup: async () => null,
    };
  }

  it("falls back to settings, once, when the onboarding screen cannot mount", async () => {
    const screens: AppleOnboardingScreens = {
      showOnboarding: vi.fn(() => {
        throw new Error("mount failed");
      }),
      showSettings: vi.fn(),
    };
    await expect(
      runAppleOnboardingFirst({ bridge: bridge(true), consent: { purposesVerified: false } }, screens),
    ).rejects.toThrow("mount failed");
    expect(screens.showSettings).toHaveBeenCalledOnce();
  });

  it("unmounts onboarding before settings mount, and stops relaying views after", async () => {
    const order: string[] = [];
    let watched: ((view: unknown) => void) | undefined;
    let relay!: (listener: (view: never) => void) => () => void;
    let props!: () => Record<string, (() => void) | undefined>;
    const screens: AppleOnboardingScreens = {
      showOnboarding: (host, watch) => {
        relay = watch as typeof relay;
        props = () => (host.view.visible ? (host.view.props as never) : {});
        watch((view) => (watched = () => view));
        return () => order.push("unmount onboarding");
      },
      showSettings: () => order.push("settings"),
    };
    const result = await runAppleOnboardingFirst(
      { bridge: bridge(true), consent: { purposesVerified: false }, destinations: ["settings"] },
      screens,
    );
    expect(result).toBe("onboarding");
    props().onContinue?.();
    props().onAssertEnabled?.();
    expect(props().onOpenSafari).toBeUndefined();
    props().onGoToSettings?.();
    await vi.waitFor(() => expect(order).toEqual(["unmount onboarding", "settings"]));
    expect(watched).toBeDefined();
    const late = vi.fn();
    relay(late);
    expect(late).not.toHaveBeenCalled();
  });

  it("a destination left out renders disabled and cannot complete", async () => {
    const onDone = vi.fn();
    const completeOnboarding = vi.fn(async () => true);
    const host = createAppleOnboardingHost({
      bridge: { ...bridge(true), completeOnboarding },
      consent: { purposesVerified: false },
      destinations: ["settings"],
      onDone,
    });
    await host.start();
    const props = () => (host.view.visible ? host.view.props : undefined)!;
    props().onContinue?.();
    props().onAssertEnabled?.();
    expect(props().step).toBe(4);
    expect(props().onOpenSafari).toBeUndefined();
    expect(props().onGoToSettings).toBeTypeOf("function");
    props().onGoToSettings?.();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledExactlyOnceWith("settings"));
    expect(completeOnboarding).toHaveBeenCalledOnce();
  });
});

describe("entry wiring", () => {
  it("reaches D12 only through the D04 branch's dynamic import, never statically", () => {
    const main = readFileSync(MAIN_PATH, "utf8");
    expect(main).toContain("if (appleSettingsAdapter) void mountAppleScreens(appleSettingsAdapter);");
    expect(main.match(/import\("\.\/apple-onboarding\.js"\)/g)).toHaveLength(1);
    expect(main).not.toMatch(/^import[^;]*(apple-onboarding|AppleOnboarding)/m);
    // #282 review P3-2: loading or mounting the screens never escapes as an unhandled rejection;
    // any failure requests settings (once), and a failed settings mount is caught too.
    const screens = main.slice(main.indexOf("async function mountAppleScreens"));
    expect(screens).toMatch(/try \{\s*const \{ showAppleOnboardingFirst \} = await import\("\.\/apple-onboarding\.js"\);/);
    expect(screens).toMatch(/\} catch \{\s*showSettings\(\);\s*\}/);
    expect(screens).toMatch(/void mountAppleSettings\(adapter\)\.catch\(/);
    const wiring = readFileSync(WIRING_PATH, "utf8");
    // No consent producer exists yet: no committer, no purposes, the question is skipped.
    expect(wiring).toContain("consent: { purposesVerified: false }");
    expect(wiring).not.toMatch(/sharing\s*:/);
    expect(wiring).not.toMatch(/purposes\s*:/);
  });
});

// VD-10: D12 is a full-screen layout (content centred, Continue anchored at the bottom).
// `.ob { min-height: 100% }` needs a parent of definite height, which html > body > #app never is
// (`min-block-size: 100%` gives body and #app no definite height), so the step sat at the top.
// The app host supplies the screen height around the step instead.
describe("D12 fills the web view", () => {
  it("mounts each step inside the host's full-height viewport", async () => {
    const app = fakeAppleHost({ presenter: "web" });
    const { target } = await launch(app.bridge);
    const step = target.querySelector("main.ob");
    expect(step).not.toBeNull();
    expect(step!.parentElement?.classList.contains("onboarding-viewport")).toBe(true);
  });

  it("gives that viewport the screen height and lets the step grow into it", () => {
    const host = readFileSync(resolve(APP_WEBVIEW, "AppleOnboardingHost.svelte"), "utf8");
    const style = host
      .slice(host.indexOf("<style>"), host.indexOf("</style>"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const viewport = /\.onboarding-viewport\s*\{([^}]*)\}/.exec(style)?.[1] ?? "";
    expect(viewport).toMatch(/display:\s*flex;/);
    expect(viewport).toMatch(/flex-direction:\s*column;/);
    // 100vh first as the fallback, then the dynamic viewport height where WebKit supports it.
    expect(viewport).toMatch(/min-block-size:\s*100vh;\s*min-block-size:\s*100dvh;/);
    expect(style).toMatch(/\.onboarding-viewport\s*>\s*:global\(\.ob\)\s*\{\s*flex:\s*1 0 auto;\s*\}/);
  });
});
