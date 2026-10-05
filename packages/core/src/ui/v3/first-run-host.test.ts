import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/svelte";
import FirstRun from "./FirstRun.svelte";
import {
  FIRST_RUN_PAGE,
  FIRST_RUN_PIN_GUIDANCE,
  FIRST_RUN_SETUP_DESCRIPTION,
  firstRunHostProps,
  firstRunPermissionGuidance,
  shouldOpenFirstRun,
  type FirstRunHostObservations,
} from "./first-run-host.js";

const ALL_ON = {
  globalOn: true,
  services: { youtube: true, instagram: true, facebook: true, tiktok: true },
} as const;

function host(overrides: Partial<FirstRunHostObservations> = {}): FirstRunHostObservations {
  return {
    browser: "chrome",
    siteAccess: "granted",
    choices: ALL_ON,
    pinned: false,
    account: null,
    onSignIn: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenPrivacy: vi.fn(),
    ...overrides,
  };
}

describe("first-run install rule", () => {
  it("opens only for a brand-new install", () => {
    expect(shouldOpenFirstRun({ reason: "install" })).toBe(true);
    for (const reason of ["update", "chrome_update", "shared_module_update", "browser_update", ""])
      expect(shouldOpenFirstRun({ reason })).toBe(false);
  });
  it("names the built extension page", () => {
    expect(FIRST_RUN_PAGE).toBe("/first-run.html");
  });
});

describe("first-run host mapping", () => {
  it("uses the approved reference wording verbatim", () => {
    expect(firstRunPermissionGuidance("firefox")).toBe(
      "Firefox asks once. Still only runs on these four sites.",
    );
    expect(firstRunPermissionGuidance("chrome")).toBe(
      "Chrome asks once. Still only runs on these four sites.",
    );
    expect(FIRST_RUN_SETUP_DESCRIPTION).toBe(
      "Allow Still on the sites it works on, and it starts right away.",
    );
    expect(FIRST_RUN_PIN_GUIDANCE).toEqual({
      chrome: "Click the puzzle piece in the toolbar, then the pin next to Still.",
      firefox:
        "Click the puzzle piece in the toolbar, then the gear next to Still, then Pin to toolbar.",
    });
  });

  it("never supplies combined consent; the host's existing control fills that slot", () => {
    const props = firstRunHostProps(host());
    expect("consent" in props).toBe(false);
    expect("privacyActions" in props).toBe(false);
  });

  it.each(["needed", "pending", "denied", "granted"] as const)(
    "reports observed %s site access as verified, without inventing a grant",
    (siteAccess) => {
      const request = vi.fn();
      const props = firstRunHostProps(host({ browser: "firefox", siteAccess, requestSiteAccess: request }));
      expect(props.permission).toMatchObject({
        state: siteAccess,
        verified: true,
        requestVerified: true,
        onRequest: request,
      });
      expect(props.setupDescription).toEqual(
        siteAccess === "granted"
          ? undefined
          : { verified: true, text: FIRST_RUN_SETUP_DESCRIPTION },
      );
    },
  );

  it("keeps unread access unverified and offers no request", () => {
    const props = firstRunHostProps(host({ siteAccess: "unknown", requestSiteAccess: vi.fn() }));
    expect(props.permission.verified).toBe(false);
    expect(props.permission.requestVerified).toBe(false);
    expect(props.setupDescription).toBeUndefined();
  });

  it("offers no request where the browser cannot ask", () => {
    const props = firstRunHostProps(host({ siteAccess: "needed" }));
    expect(props.permission.requestVerified).toBe(false);
    expect(props.permission.onRequest).toBeUndefined();
  });

  it("reads blocking from the saved choices only, never from defaults", () => {
    expect(firstRunHostProps(host({ choices: null })).blocking).toEqual({
      state: "unknown",
      verified: false,
    });
    expect(firstRunHostProps(host()).blocking).toEqual({ state: "on", verified: true });
    expect(
      firstRunHostProps(host({ choices: { ...ALL_ON, globalOn: false } })).blocking,
    ).toEqual({ state: "off", verified: true });
    expect(
      firstRunHostProps(
        host({
          choices: {
            globalOn: true,
            services: { youtube: false, instagram: false, facebook: false, tiktok: false },
          },
        }),
      ).blocking,
    ).toEqual({ state: "off", verified: true });
  });

  it("reports pinning only from Chrome's own answer; Firefox stays instructions", () => {
    expect(firstRunHostProps(host({ pinned: true })).pin).toMatchObject({ pinned: true, verified: true });
    expect(firstRunHostProps(host({ pinned: false })).pin).toMatchObject({ pinned: false, verified: true });
    expect(firstRunHostProps(host({ pinned: null })).pin).toMatchObject({ pinned: false, verified: false });
    const firefox = firstRunHostProps(host({ browser: "firefox", pinned: true })).pin;
    expect(firefox).toEqual({
      pinned: false,
      verified: false,
      guidance: { verified: true, text: FIRST_RUN_PIN_GUIDANCE.firefox },
    });
  });

  it("leaves the pin step out only where the browser reports no toolbar (Firefox for Android)", () => {
    expect(firstRunHostProps(host({ browser: "firefox", pinned: null, toolbar: false }))).not.toHaveProperty("pin");
    // Absent or true keeps today's step on every desktop browser.
    for (const toolbar of [undefined, true]) {
      expect(firstRunHostProps(host({ browser: "firefox", pinned: null, toolbar })).pin).toEqual({
        pinned: false,
        verified: false,
        guidance: { verified: true, text: FIRST_RUN_PIN_GUIDANCE.firefox },
      });
      expect(firstRunHostProps(host({ toolbar })).pin).toMatchObject({ pinned: false, verified: true });
    }
  });

  it("shows an account only when the background reports one with an address", () => {
    const onSignIn = vi.fn();
    expect(firstRunHostProps(host({ onSignIn })).sync).toEqual({ onSignIn });
    expect(
      firstRunHostProps(host({ onSignIn, account: { userId: "u1", email: " a@b.test " } })).sync,
    ).toEqual({ account: { address: "a@b.test", confirmed: true } });
    // A session without an address is neither shown as signed in nor offered a second sign-in.
    expect(
      firstRunHostProps(host({ onSignIn, account: { userId: "u1", email: null } })).sync,
    ).toEqual({ onSignIn: undefined });
  });

  it("disables destinations the host did not supply", () => {
    const props = firstRunHostProps(host({ onOpenSettings: undefined, onOpenPrivacy: undefined }));
    expect(props.settings).toEqual({ verified: false, onOpen: undefined });
    expect(props.privacy).toEqual({ verified: false, onOpen: undefined });
  });
});

describe("first-run host mapping rendered by the approved component", () => {
  it("Chrome, just installed: working, pin instructions, optional sign-in, no combined consent card", () => {
    render(FirstRun, { props: firstRunHostProps(host()) });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Still is on.");
    expect(screen.getByText(FIRST_RUN_PIN_GUIDANCE.chrome)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect(screen.queryByText("Share your email and usage data with Still?")).toBeNull();
  });

  it("Firefox, permission needed: asks with the approved wording and an enabled Allow", () => {
    const requestSiteAccess = vi.fn();
    render(FirstRun, {
      props: firstRunHostProps(
        host({ browser: "firefox", siteAccess: "needed", pinned: null, requestSiteAccess }),
      ),
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("One step to finish setup.");
    expect(screen.getByText(FIRST_RUN_SETUP_DESCRIPTION)).toBeInTheDocument();
    expect(screen.getByText(firstRunPermissionGuidance("firefox"))).toBeInTheDocument();
    expect(screen.getByText(FIRST_RUN_PIN_GUIDANCE.firefox)).toBeInTheDocument();
    screen.getByRole("button", { name: "Allow" }).click();
    expect(requestSiteAccess).toHaveBeenCalledOnce();
  });

  it("Firefox for Android: no pin step and no new words; sign-in becomes step 2", () => {
    const { container } = render(FirstRun, {
      props: firstRunHostProps(
        host({ browser: "firefox", siteAccess: "needed", pinned: null, toolbar: false, requestSiteAccess: vi.fn() }),
      ),
    });
    expect(screen.queryByText("Pin Still to your toolbar")).toBeNull();
    expect(screen.queryByText(FIRST_RUN_PIN_GUIDANCE.firefox)).toBeNull();
    const steps = [...container.querySelectorAll("ol.steps > li.step")];
    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.querySelector(".num")?.textContent?.trim())).toEqual(["1", "2"]);
    expect(steps[0]).toHaveTextContent("Allow Still on supported sites");
    expect(steps[1]).toHaveTextContent("Settings sync");
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  it("desktop Firefox keeps the three numbered steps", () => {
    const { container } = render(FirstRun, {
      props: firstRunHostProps(host({ browser: "firefox", siteAccess: "needed", pinned: null })),
    });
    const steps = [...container.querySelectorAll("ol.steps > li.step")];
    expect(steps.map((step) => step.querySelector(".num")?.textContent?.trim())).toEqual(["1", "2", "3"]);
    expect(steps[1]).toHaveTextContent("Pin Still to your toolbar");
  });

  it("access granted but Still switched off never claims Still is on", () => {
    render(FirstRun, {
      props: firstRunHostProps(host({ choices: { ...ALL_ON, globalOn: false } })),
    });
    expect(screen.queryByText("Still is on.")).toBeNull();
  });
});
