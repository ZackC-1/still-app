import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/svelte";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import PurchaseView from "./PurchaseView.svelte";
import PopupInvitation from "./PopupInvitation.svelte";
import type { PurchaseViewProps } from "./purchase-presentation.js";
import type { PopupInvitationPresentation } from "./invitation-presentation.js";
import { POPUP_PRO_VALUE, proValueBySite } from "./presentation.js";
import { SITE_ACCESS_COPY, siteAccessBody, siteAccessTitle } from "./site-access-presentation.js";
import { SHARED_DATA_COPY } from "./withdrawal-copy.js";
import { USAGE_SWITCH_COPY } from "./usage-copy.js";
import { STRINGS } from "../strings.js";

// The 22 Oct 2026 copy audit and the owner's rulings on it. The house rules: curly marks, no full
// stop on headings, titles and buttons, no serial comma, error lines start "We couldn’t …", and
// US spelling.

afterEach(cleanup);

/** An admitted invitation, as PopupInvitation.test.ts builds it. */
function admitted(
  kind: "rating" | "sync" | "link" = "rating",
): PopupInvitationPresentation {
  const identity = {
    installation: "specimen-install",
    opening: "specimen-opening",
    surface: "chrome",
  };
  return {
    kind,
    identity,
    verified: true,
    fresh: true,
    status: "ready",
    ordinaryOpening: true,
    rating: {
      allowance: { verified: true, fresh: true, global: true, surface: true },
      eligibility: {
        verified: true,
        ageDays: 7,
        distinctUseDays: 3,
        laterOpening: true,
      },
      display: {
        verified: true,
        fresh: true,
        status: "admitted",
        receiptId: "specimen-display",
        identity: { ...identity },
      },
    },
    accept: {
      verified: true,
      status: "ready",
      identity: { ...identity },
      request: vi.fn(),
    },
    dismiss: {
      verified: true,
      status: "ready",
      identity: { ...identity },
      request: vi.fn(),
    },
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(join(here, file), "utf8");

describe("house rule: curly apostrophes in V3 copy", () => {
  // A contraction with a straight apostrophe on a line that is not a comment. SharingCard is not
  // drawn by any shipped host and keeps its wording until the owner rules on it.
  const CONTRACTION = /\b(?:can|couldn|didn|doesn|don|isn|wasn|hasn|won|you|we|it|that|I)'(?:t|re|ll|s|ve|m)\b/i;
  const commentLine = /^\s*(?:\/\/|\*|\/\*|<!--)/;
  const files = readdirSync(here).filter(
    (file) =>
      /\.(svelte|ts)$/.test(file) &&
      !/\.test\.ts$|test-fixtures|fixtures\.ts$/.test(file) &&
      file !== "SharingCard.svelte",
  );

  it.each(files)("%s", (file) => {
    const offending = source(file)
      .split("\n")
      .filter((line) => !commentLine.test(line))
      .map((line) => line.replace(/\/\/.*$/, "").replace(/<!--.*?-->/g, ""))
      .filter((line) => CONTRACTION.test(line));
    expect(offending).toEqual([]);
  });
});

describe("house rule: no serial comma", () => {
  it("names the four sites without one", () => {
    expect(siteAccessBody()).toBe(
      "Still needs permission to work on Instagram, Facebook, YouTube and TikTok.",
    );
    expect(SITE_ACCESS_COPY.allowed).toBe("Allowed on Instagram, Facebook, YouTube and TikTok.");
    expect(POPUP_PRO_VALUE).toBe(
      "Even fewer distractions on Instagram, Facebook and YouTube. One-time purchase.",
    );
  });

  it("joins every site's Still Pro value list without one", () => {
    for (const { what } of proValueBySite()) expect(what).not.toMatch(/, and /);
    expect(proValueBySite().find((row) => row.service === "facebook")?.what).toBe(
      "Stories, the Video tab and desktop sidebar ads",
    );
  });
});

describe("house rule: headings carry no full stop", () => {
  it("the setup and site-access heading (owner's wording, 21 Oct)", () => {
    expect(siteAccessTitle()).toBe("Still can’t block distractions yet");
  });
});

describe("error lines start “We couldn’t …”", () => {
  it("in the sign-in sheet and account deletion", () => {
    expect(STRINGS.codeAuth.sendError).toBe("We couldn’t send the code. Try again.");
    expect(STRINGS.codeAuth.resendError).toBe(
      "We couldn’t send a new code. The last one may still work.",
    );
    expect(STRINGS.account.deleteError).toBe("We couldn’t delete your account. Try again.");
  });

  it("keeps the owner's own sync line (21 Oct), with a curly apostrophe", () => {
    expect(STRINGS.sync.failed).toBe("Sync didn’t finish. Settings are saved on this device.");
  });
});

describe("owner rulings, 22 Oct 2026", () => {
  it("the shared-data link matches its dialog title", () => {
    expect(SHARED_DATA_COPY.label).toBe("Delete shared data from all your devices");
  });

  it("the usage switch line", () => {
    expect(USAGE_SWITCH_COPY.body).toBe(
      "Helps improve Still. Never shares the websites, pages or videos you visit.",
    );
  });

  it("a settings screen loading is not a sync check", () => {
    expect(STRINGS.sync.loading).toBe("Loading your settings…");
    expect(STRINGS.sync.checking).toBe("Checking sync…");
  });

  it("the sign-in sheet's close button says sign-in as a noun", () => {
    expect(STRINGS.auth.dismissLabel).toBe("Close sign-in");
  });

  it("each host names an unavailable Still Pro row its own way", () => {
    expect(source("AppleSettings.svelte")).toContain('unsupportedText="Not available on this device."');
    expect(source("DesktopPopup.svelte")).toContain(
      'unsupportedText={`Not available in ${appHandoff ? "Safari" : "this browser"}. Your choice is saved.`}',
    );
    expect(
      readFileSync(
        join(here, "../../../../ext-safari/entrypoints/options/SafariV3Options.svelte"),
        "utf8",
      ),
    ).toContain('unsupportedText="Not available in Safari. Your choice is saved."');
  });

  it("the rating invitation asks, and its button rates", () => {
    render(PopupInvitation, { props: { presentation: admitted("rating") } });
    const card = screen.getByRole("region", { name: "Enjoying Still?" });
    expect(within(card).getByRole("button", { name: "Rate Still" })).toBeInTheDocument();
  });

  it("the sync invitation reads as the Settings sync card (no “every browser”)", () => {
    render(PopupInvitation, { props: { presentation: admitted("sync") } });
    expect(screen.getByRole("region", { name: "Settings sync" })).toBeInTheDocument();
    expect(screen.getByText("Sync settings across devices and browsers. Free.")).toBeInTheDocument();
    expect(source("PopupInvitation.svelte")).not.toContain("every browser");
  });
});

describe("purchase view wording per host", () => {
  const controls = [{ site: "YouTube", label: "Comments" }];
  const common = {
    controls,
    access: { state: "none", verified: true },
    channel: "ready",
    offer: { price: "verified fixture", verified: true },
    purchase: { state: "idle" },
    onBack: vi.fn(),
    restore: { state: "nothing", verified: true, conclusive: true },
  };
  const browser = {
    ...common,
    host: "browser",
    checkout: { verified: true, onRequest: vi.fn() },
    restorePort: { verified: true, onRequest: vi.fn() },
    onSignIn: vi.fn(),
  } as unknown as PurchaseViewProps;
  const apple = {
    ...common,
    host: "apple",
    native: { verified: true, onBuy: vi.fn(), onRestore: vi.fn() },
  } as unknown as PurchaseViewProps;

  it("states the terms in one way, ending in a full stop", () => {
    render(PurchaseView, { props: browser });
    expect(
      screen.getByText(
        "More control over Instagram, Facebook and YouTube. One-time purchase. Lifetime access. No subscription.",
      ),
    ).toBeInTheDocument();
  });

  it("browser: account wording and the Still settings back link", () => {
    render(PurchaseView, { props: browser });
    expect(screen.getByText("No Still Pro purchase was found for this account.")).toBeInTheDocument();
    expect(
      screen.getByText("Bought it with another account? Sign in with that one and try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to Still settings" })).toBeInTheDocument();
  });

  it("Apple: Apple Account wording", () => {
    render(PurchaseView, { props: apple });
    expect(
      screen.getByText("No Still Pro purchase was found for this Apple Account."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Bought it with another Apple Account? Sign in with that one and try again."),
    ).toBeInTheDocument();
  });

  it("the checking line says the free controls keep working", () => {
    render(PurchaseView, {
      props: { ...browser, restore: { state: "checking", verified: true, conclusive: false } } as PurchaseViewProps,
    });
    expect(
      screen.getByText("Your free controls keep working while this finishes."),
    ).toBeInTheDocument();
  });
});
