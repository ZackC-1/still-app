import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AppleSettings from "./AppleSettings.svelte";
import { fixture as settingsFixture } from "./ExtensionSettings.test-fixtures.js";
import type { AppleSettingsProps } from "./apple-settings-presentation.js";

// The iPhone and Mac app screens measured against the owner's screens canvas (22 Oct 2026, the
// canvas-fidelity check): the parts P-AppSync, P-Invite, P-AppPro, P-Restore and P-Sites. The canvas
// is the owner-approved truth; each case pins the build to the canvas number it now matches.

afterEach(cleanup);

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(join(here, file), "utf8");
const components = () => source("design/tokens/components.css");
const rule = (css: string, selector: string) =>
  css.match(
    new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "m"),
  )?.[1] ?? "";
/** A rule from AppleSettings.svelte's own <style> block (two-space indented, one declaration a line). */
const appleRule = (selector: string) => {
  const style = source("AppleSettings.svelte").split("<style>")[1] ?? "";
  const at = style.indexOf(`${selector} {`);
  return at < 0 ? "" : style.slice(at, style.indexOf("}", at));
};

const ACCOUNT = {
  address: "person@still.test",
  identity: "account-a",
  revision: 1,
  confirmed: true,
  onSignOut: vi.fn(),
  onDeleteAccount: vi.fn(),
};
const OFFER = { price: "$9.99", priceNote: "One-time purchase. Lifetime access." };

async function props(
  access: "locked" | "purchased",
  extra: Partial<AppleSettingsProps>,
): Promise<AppleSettingsProps> {
  const { props: base } = await settingsFixture(access);
  return {
    platform: "ios",
    phone: true,
    settings: base.settings,
    access: base.access,
    onGlobalChange: vi.fn(),
    onServiceChange: vi.fn(),
    onFeatureChange: vi.fn(),
    sync: { onSignIn: vi.fn() },
    help: { onGuide: vi.fn(), onSafariSetup: vi.fn(), onSupport: vi.fn(), onPrivacy: vi.fn() },
    ...extra,
  };
}
const holder = { ownership: "owned", channel: "ready", offer: OFFER } as const;
const invitation = (signedIn: boolean) => ({
  eligibleLaterVisit: true,
  signedIn,
  onLink: vi.fn(),
  onDismiss: vi.fn(),
});

describe("P-AppSync: Sign in and Not now are one 54px row", () => {
  it("the holder's Sign in and Not now sit in the sync card's split row", async () => {
    render(AppleSettings, {
      props: await props("purchased", { pro: holder, linkInvitation: invitation(false) }),
    });
    const notNow = screen.getByRole("button", { name: "Not now" });
    expect(notNow).toHaveClass("secondary", "block");
    expect(notNow.parentElement).toHaveClass("split-actions");
    expect(screen.getByRole("button", { name: "Sign in" }).parentElement).toBe(
      notNow.parentElement,
    );
  });

  it("Not now's 1px border comes out of its padding, in the strong border colour", () => {
    // Without this the outlined button is 56.4px and stretches Sign in with it (canvas 54).
    expect(appleRule(".app :global(.split-actions > .secondary.block)")).toContain(
      "border-color: var(--border-strong);",
    );
    // Every Apple outlined block button's border comes out of its padding (review F2).
    expect(rule(components(), '[data-host="apple"] .secondary.block')).toContain(
      "padding-block: calc(var(--space-4) - 1px);",
    );
  });
});

describe("P-Invite: the signed-in link offer's Link button", () => {
  it("Link and Not now share the offer's own action row", async () => {
    render(AppleSettings, {
      props: await props("purchased", {
        pro: holder,
        sync: { account: { ...ACCOUNT } },
        linkInvitation: invitation(true),
      }),
    });
    const link = screen.getByRole("button", { name: "Link" });
    expect(link).toHaveClass("primary", "inline");
    expect(link.parentElement).toHaveClass("inline-actions", "link-invite-actions");
    expect(screen.getByRole("button", { name: "Not now" }).parentElement).toBe(
      link.parentElement,
    );
  });

  it("is 44px tall at 15px with 16px before Not now (canvas: 70 × 44, card 109px)", () => {
    expect(appleRule(".link-invite-actions")).toContain("gap: var(--space-2) var(--space-4);");
    const button = appleRule(".link-invite-actions > .primary.inline");
    expect(button).toContain("min-block-size: var(--tap-target);");
    expect(button).toContain("padding: 10px 20px;");
    expect(button).toContain("font-size: calc(15px * var(--text-scale, 1));");
  });
});

describe("P-AppPro and P-Restore: the cards' status lines are 14px", () => {
  it("the Still Pro card's status line sits in the Pro slot", async () => {
    render(AppleSettings, {
      props: await props("locked", {
        pro: { ownership: "failed", channel: "ready", offer: OFFER, onRestore: vi.fn() },
      }),
    });
    expect(
      screen.getByText("We couldn’t finish checking. Nothing changed.").closest(".pro-slot"),
    ).not.toBeNull();
  });

  it("the restore card carries its own hook class", async () => {
    render(AppleSettings, {
      props: await props("locked", {
        pro: { ownership: "none", channel: "ready", offer: OFFER, onBuy: vi.fn(), onRestore: vi.fn() },
        restore: { state: "checking" },
      }),
    });
    expect(
      screen.getByText("Checking for Still Pro purchases…").closest("section.restore-card"),
    ).not.toBeNull();
  });

  it("both cards draw 14px status text with the glyph centred on the first line", () => {
    const style = source("AppleSettings.svelte").split("<style>")[1] ?? "";
    expect(style).toMatch(
      /\.pro-slot :global\(\.status-line\),\n\s+\.app :global\(\.restore-card \.status-line\) \{\n\s+font-size: calc\(14px \* var\(--text-scale, 1\)\);/,
    );
    expect(style).toMatch(
      /\.pro-slot :global\(\.status-line \.glyph\),\n\s+\.app :global\(\.restore-card \.status-line \.glyph\) \{\n\s+margin-block-start: 2px;/,
    );
  });
});

/** The declarations of the last top-level rule for a selector: the one that wins at equal specificity. */
const lastRule = (css: string, selector: string) => {
  const all = [
    ...css.matchAll(
      new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "gm"),
    ),
  ];
  return all.at(-1)?.[1] ?? "";
};

describe("P-Sites: an open site's option rows", () => {
  it("each row is 46px on the app and Settings page, 40px in the popups", () => {
    expect(lastRule(components(), ".option-row")).toContain("min-block-size: 46px;");
    // The popups' rule is more specific, so it keeps 40px over the base 46px rule.
    expect(rule(components(), '.app[data-density="compact"] .option-row')).toContain(
      "min-block-size: 40px;",
    );
  });

  it("6px under the last row", () => {
    // One rule, folded with the Safari lane's edit: top 0, inline, bottom 6px.
    expect(lastRule(components(), ".service-options .list")).toMatch(
      /padding: 0 var\(--service-card-padding-inline, var\(--space-4\)\) 6px /,
    );
  });
});

describe("P-Sites: a locked row is 49px on the app and Settings page, 40px in the popups", () => {
  it("keeps 8px around the switch and pill outside the popups, and the name's own padding", () => {
    const css = components();
    expect(lastRule(css, '.option-row[data-access="locked"] .locked-controls')).toContain(
      "margin-block: var(--space-2);",
    );
    expect(
      rule(css, '.app[data-density="compact"] .option-row[data-access="locked"] .locked-controls'),
    ).toContain("margin-block: 3px;");
    // The name keeps its 8px (the base row-main rule), so wrapped controls never cover it.
    expect(rule(css, '.option-row[data-access="locked"] .row-main')).not.toContain("padding-block");
  });
});

describe("status actions: Try again is a plain 13px link", () => {
  it("no semibold weight", () => {
    const css = rule(components(), ".status-line .status-action");
    expect(css).toContain("font-size: calc(13px * var(--text-scale, 1));");
    expect(css).not.toMatch(/font-weight/);
  });
});
