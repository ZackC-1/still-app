import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/svelte";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import PurchaseView from "./PurchaseView.svelte";
import PopupInvitation from "./PopupInvitation.svelte";
import PopupProCard from "./PopupProCard.svelte";
import type { PurchaseViewProps } from "./purchase-presentation.js";
import type { PopupInvitationPresentation } from "./invitation-presentation.js";
import { POPUP_PRO_VALUE, proValueBySite } from "./presentation.js";
import { SITE_ACCESS_COPY, siteAccessBody, siteAccessTitle } from "./site-access-presentation.js";
import { SHARED_DATA_COPY } from "./withdrawal-copy.js";
import { USAGE_SWITCH_COPY } from "./usage-copy.js";
import { STRINGS } from "../strings.js";
import { APPLE_PURCHASE_SIGN_IN_COPY } from "./apple-pro-host.js";

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

const packages = join(here, "../../../..");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "__tests__" || entry.name === "node_modules" ? [] : walk(path);
    return /\.(svelte|ts)$/.test(entry.name) ? [path] : [];
  });
/** Every source file that holds user-visible copy for a shipped screen. */
const files = [
  join(packages, "core/src/ui/strings.ts"),
  ...readdirSync(join(packages, "core/src/ui"))
    .filter((name) => name.endsWith(".svelte"))
    .map((name) => join(packages, "core/src/ui", name)),
  ...walk(join(packages, "core/src/ui/components")),
  ...walk(here),
  ...walk(join(packages, "ext-safari/entrypoints")),
  ...walk(join(packages, "ext-chromium/entrypoints")),
  ...walk(join(packages, "app-webview/src")),
]
  .filter(
    (path) =>
      !/\.test\.ts$|test-fixtures|fixtures\.ts$/.test(path) &&
      // Not drawn by any shipped host; its wording waits for the owner.
      !path.endsWith("SharingCard.svelte"),
  )
  .map((path) => path.slice(packages.length + 1));

describe("house rule: curly apostrophes in user-visible copy", () => {
  // A contraction or a possessive with a straight apostrophe, on a line that is not a comment.
  const CONTRACTION =
    /\b(?:can|couldn|didn|doesn|don|isn|wasn|hasn|haven|won|wouldn|aren|you|we|it|that|I|there|what|let)'(?:t|re|ll|s|ve|m|d)\b/i;
  const POSSESSIVE = /\b[A-Z][A-Za-z]*'s\b/; // Still's, Safari's, Firefox's
  const commentLine = /^\s*(?:\/\/|\*|\/\*|<!--)/;
  // Strings only the 2.x screens show; they keep their wording while 2.x bundles ship.
  const LEGACY_2X_ONLY = [
    "Nothing here. That's the point.",
    "Waiting for approval — we'll unlock Pro as soon as it's confirmed.",
    "Still Pro isn't available right now. Try again in a moment.",
    "We couldn't start the purchase. Try again.",
    "I didn't finish checkout — start over",
    "We haven't seen your purchase yet. If you paid, we'll find it together.",
    "You've been signed out. Sign in again to check your purchase.",
    "You're Pro",
  ];

  it.each(files)("%s", (file) => {
    const offending = readFileSync(join(packages, file), "utf8")
      .split("\n")
      .filter((line) => !commentLine.test(line))
      .map((line) =>
        line.replace(/(?<![:"'])\/\/.*$/, "").replace(/<!--.*?-->/g, ""),
      )
      .filter((line) => !LEGACY_2X_ONLY.some((legacy) => line.includes(legacy)))
      .filter((line) => CONTRACTION.test(line) || POSSESSIVE.test(line));
    expect(offending).toEqual([]);
  });

  it("catches a shared sign-in line going back to a straight apostrophe", () => {
    expect(CONTRACTION.test(`error: "We couldn't sign you in. Try again.",`)).toBe(true);
    expect(STRINGS.auth.error).toBe("We couldn’t sign you in. Try again.");
    expect(POSSESSIVE.test(`"Back in Safari, click Still's toolbar button."`)).toBe(true);
  });
});

describe("“6‑digit” stays on one line (ISS-0124)", () => {
  // With an ordinary hyphen the browser may wrap "6-" and "digit" onto two lines (owner QA on
  // 2.1.1.1444). The non-breaking hyphen U+2011 keeps them together; every bundled Inter (the web
  // font, the design-system font and the Apple app's font) has its glyph.
  const PLAIN = /6-digit/i;
  const commentLine = /^\s*(?:\/\/|\*|\/\*|<!--)/;
  const repo = join(packages, "..");
  const notTest = (path: string) => !/\.test\.ts$|test-fixtures|fixtures\.ts$|test-support/.test(path);
  const sources = [
    ...files.map((file) => join(packages, file)),
    ...walk(join(packages, "ext-chromium/lib")).filter(notTest),
    // The owner page mirrors the shipped sign-in copy.
    ...walk(join(repo, "apps/owner-admin/src")).filter(notTest),
  ].map((path) => path.slice(repo.length + 1));

  it.each(sources)("%s", (file) => {
    const offending = readFileSync(join(repo, file), "utf8")
      .split("\n")
      .filter((line) => !commentLine.test(line))
      .map((line) => line.replace(/(?<![:"'])\/\/.*$/, "").replace(/<!--.*?-->/g, ""))
      .filter((line) => PLAIN.test(line));
    expect(offending).toEqual([]);
  });

  it("catches a plain hyphen and lets the non-breaking one through", () => {
    expect(PLAIN.test(`codeLabel: "6-digit code",`)).toBe(true);
    expect(PLAIN.test(`codeLabel: "6\u2011digit code",`)).toBe(false);
  });

  it("every shared string that names the code uses the non-breaking hyphen", () => {
    const all: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === "string") all.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(STRINGS);
    expect(all.filter((line) => PLAIN.test(line))).toEqual([]);
    const named = all.filter((line) => /6.digit/.test(line));
    expect(named.length).toBeGreaterThanOrEqual(5);
    for (const line of named) expect(line).toContain("6\u2011digit");
    expect(STRINGS.codeAuth.codeLabel).toBe("6\u2011digit code");
    expect(STRINGS.codeAuth.prompt).toBe("Check your email for a 6\u2011digit sign-in code.");
    expect(APPLE_PURCHASE_SIGN_IN_COPY.prompt).toBe("Enter your email to get a 6\u2011digit sign-in code.");
  });
});

describe("the sign-in sheet says what opened it (ISS-0123, owner ruling P2-19)", () => {
  it("the purchase sign-in: title and line, and no claim that sign-in is optional", () => {
    expect(STRINGS.purchaseAuth.title).toBe("Sign in to get Still Pro");
    expect(STRINGS.purchaseAuth.note).toBe("Sign in first to keep Still Pro with your account.");
    expect(Object.values(STRINGS.purchaseAuth).join(" ")).not.toMatch(/optional/i);
  });

  it("the restore sign-in (owner ruling C, 22 Oct)", () => {
    expect(STRINGS.restoreAuth.title).toBe("Sign in to restore Still Pro");
    expect(STRINGS.restoreAuth.note).toBe("Sign in with the account you bought Still Pro with.");
    expect(Object.values(STRINGS.restoreAuth).join(" ")).not.toMatch(/optional/i);
  });

  it("the purchase consent wording (owner rulings A and B, 22 Oct)", () => {
    expect(STRINGS.emailConsent.purchaseBody).toBe(
      "Still uses your email address to send a 6\u2011digit sign-in code, keep Still Pro with your account and sync your settings across devices. Still does not collect your browsing history.",
    );
    expect(STRINGS.emailConsent.purchaseOptInTitle).toBe("Share your email to get Still Pro?");
    expect(STRINGS.emailConsent.purchaseAgree).toBe(
      "I agree to share my email for sign-in, Still Pro and settings sync.",
    );
    expect(STRINGS.emailConsent.disclosureTitle).toBe("Your email is only for sign-in");
  });

  it("the Apple purchase sheet keeps the same words and its Buy without an account", () => {
    expect(APPLE_PURCHASE_SIGN_IN_COPY).toEqual({
      title: "Sign in to get Still Pro",
      prompt: "Enter your email to get a 6\u2011digit sign-in code.",
      note: "Sign in first to keep Still Pro with your account.",
      skip: "Buy without an account",
    });
  });

  it("the settings-sync sign-in keeps its own words", () => {
    expect(STRINGS.auth.title).toBe("Sign in for settings sync");
    expect(STRINGS.auth.prompt).toBe(
      "Enter your email to get a 6\u2011digit sign-in code. Sign-in is optional. Blocking works without an account.",
    );
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

describe("checking lines name the free controls (P3-10)", () => {
  it("the popups' Still Pro card while checking", () => {
    render(PopupProCard, { props: { checking: true } });
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent("Checking your Still Pro access…");
    expect(line).toHaveTextContent("Your free controls keep working while this finishes.");
  });
});

describe("popup footer (P2-8)", () => {
  it("every popup's footer button reads “Still settings”", () => {
    for (const file of ["DesktopPopup.svelte", "MobilePopup.svelte", "../App.svelte"])
      expect(source(file), file).toMatch(/>Still settings<\/button/);
    // P3-23 (22 Oct): the iPhone Safari button no longer repeats itself as "Still settings. Opens
    // Still settings."; its name is its visible label, as on the Mac Safari and browser popups.
    expect(source("MobilePopup.svelte")).not.toContain("Opens Still settings");
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
