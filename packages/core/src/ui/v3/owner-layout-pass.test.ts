import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORT_EMAIL } from "../config.js";
import AppleSettings from "./AppleSettings.svelte";
import ExtensionSettings from "./ExtensionSettings.svelte";
import SyncCard from "./SyncCard.svelte";
import { fixture as settingsFixture } from "./ExtensionSettings.test-fixtures.js";
import type { AppleSettingsProps } from "./apple-settings-presentation.js";

// The owner's layout rulings from the screens canvas review of 21 Oct 2026 (second pass). The
// popup's "Still Pro User" markup (ruling 4) is pinned in still-pro-tag.test.ts, its grid here.

afterEach(cleanup);

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(join(here, file), "utf8");

const ACCOUNT = {
  address: "person@still.test",
  identity: "account-a",
  revision: 1,
  confirmed: true,
  onSignOut: vi.fn(),
  onDeleteAccount: vi.fn(),
};

async function appleProps(
  platform: AppleSettingsProps["platform"],
  signedIn: boolean,
): Promise<AppleSettingsProps> {
  const { props } = await settingsFixture("locked");
  return {
    platform,
    settings: props.settings,
    access: props.access,
    onGlobalChange: vi.fn(),
    onServiceChange: vi.fn(),
    onFeatureChange: vi.fn(),
    sync: signedIn ? { account: { ...ACCOUNT } } : { onSignIn: vi.fn() },
    sharing: { state: "off", onChange: vi.fn() },
    help: {
      onGuide: vi.fn(),
      onSafariSetup: vi.fn(),
      onSupport: vi.fn(),
      onPrivacy: vi.fn(),
    },
  };
}

async function browserProps(signedIn: boolean) {
  const { props } = await settingsFixture("locked");
  if (signedIn) props.sync = { account: { ...ACCOUNT } };
  return props;
}

const help = () => screen.getByRole("region", { name: "Help" });
const sharingCard = () =>
  screen.getByText("Share email and usage data").closest("section")!;

/** The Help card's grid cells: what each holds, its column and its row. */
function cells() {
  return Array.from(help().children).map((cell) => ({
    text: Array.from(cell.querySelectorAll("button, p"))
      .concat(cell.matches("button, p") ? [cell] : [])
      .map((part) => part.textContent?.trim())
      .join(" + "),
    column: cell.getAttribute("data-help-column"),
    row: cell.getAttribute("data-help-row"),
  }));
}

function column(side: "left" | "right") {
  return cells()
    .filter((cell) => cell.column === side)
    .sort((a, b) => Number(a.row) - Number(b.row))
    .map((cell) => cell.text);
}

const tabOrder = () =>
  within(help())
    .getAllByRole("button")
    .map((button) => button.textContent?.trim());

describe("ruling 9: Share usage data sits below Help", () => {
  it.each(["ios", "mac"] as const)("Apple app (%s)", async (platform) => {
    render(AppleSettings, { props: await appleProps(platform, false) });
    expect(help().nextElementSibling).toBe(sharingCard());
  });

  it("Chrome and Firefox Settings", async () => {
    render(ExtensionSettings, { props: await browserProps(false) });
    expect(help().nextElementSibling).toBe(sharingCard());
  });

  it("a host's own privacy actions take the same place, below Help", async () => {
    const { createRawSnippet } = await import("svelte");
    const privacyActions = createRawSnippet(() => ({
      render: () => '<button type="button">Keep usage sharing off</button>',
    }));
    const apple = render(AppleSettings, {
      props: { ...(await appleProps("ios", false)), sharing: undefined, privacyActions },
    });
    expect(help().nextElementSibling).toBe(
      screen.getByRole("button", { name: "Keep usage sharing off" }),
    );
    apple.unmount();
    const props = await browserProps(false);
    render(ExtensionSettings, {
      props: { ...props, sharing: undefined, privacyActions },
    });
    expect(help().nextElementSibling).toBe(
      screen.getByRole("button", { name: "Keep usage sharing off" }),
    );
  });
});

describe("ruling 10: the Help card's links in two columns", () => {
  describe.each(["ios", "mac"] as const)("Apple app (%s)", (platform) => {
    it("signed out: Setup guide and Safari setup on the left; Privacy policy, then Contact support with the address, on the right", async () => {
      render(AppleSettings, { props: await appleProps(platform, false) });
      expect(column("left")).toEqual(["Setup guide", "Safari setup"]);
      expect(column("right")).toEqual([
        "Privacy policy",
        `Contact support + ${SUPPORT_EMAIL}`,
      ]);
      expect(tabOrder()).toEqual([
        "Setup guide",
        "Safari setup",
        "Privacy policy",
        "Contact support",
      ]);
    });

    it("signed in: Delete account closes the left column and stays last in Tab order", async () => {
      render(AppleSettings, { props: await appleProps(platform, true) });
      expect(column("left")).toEqual(["Setup guide", "Safari setup", "Delete account"]);
      expect(column("right")).toEqual([
        "Privacy policy",
        `Contact support + ${SUPPORT_EMAIL}`,
      ]);
      expect(tabOrder()).toEqual([
        "Setup guide",
        "Safari setup",
        "Privacy policy",
        "Contact support",
        "Delete account",
      ]);
    });
  });

  it("Chrome and Firefox Settings, signed out: Setup guide on the left; Privacy policy, then Contact support with the address, on the right", async () => {
    render(ExtensionSettings, { props: await browserProps(false) });
    expect(column("left")).toEqual(["Setup guide"]);
    expect(column("right")).toEqual([
      "Privacy policy",
      `Contact support + ${SUPPORT_EMAIL}`,
    ]);
    expect(tabOrder()).toEqual(["Setup guide", "Privacy policy", "Contact support"]);
  });

  it("Chrome and Firefox Settings, signed in: Delete account under Setup guide, last in Tab order", async () => {
    render(ExtensionSettings, { props: await browserProps(true) });
    expect(column("left")).toEqual(["Setup guide", "Delete account"]);
    expect(column("right")).toEqual([
      "Privacy policy",
      `Contact support + ${SUPPORT_EMAIL}`,
    ]);
    expect(tabOrder()).toEqual([
      "Setup guide",
      "Privacy policy",
      "Contact support",
      "Delete account",
    ]);
  });

  it("every cell sits in its own row of one column", async () => {
    render(AppleSettings, { props: await appleProps("ios", true) });
    const places = cells().map((cell) => `${cell.column}:${cell.row}`);
    expect(new Set(places).size).toBe(places.length);
    for (const cell of cells()) {
      expect(["left", "right"]).toContain(cell.column);
      expect(["1", "2", "3"]).toContain(cell.row);
    }
  });

  it("the stylesheet draws two columns, 44px links, and one column above 1.5× text", () => {
    const css = source("design/tokens/components.css");
    const rule = (selector: string) =>
      css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
    expect(rule(".card-stack.help")).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr));",
    );
    expect(rule('.card-stack.help > [data-help-column="left"]')).toContain("grid-column: 1;");
    expect(rule('.card-stack.help > [data-help-column="right"]')).toContain("grid-column: 2;");
    for (const row of ["1", "2", "3"])
      expect(rule(`.card-stack.help > [data-help-row="${row}"]`)).toContain(`grid-row: ${row};`);
    expect(rule(".card-stack.help .link")).toContain("min-block-size: var(--tap-target);");
    expect(rule('html[data-still-text-scale="large"] .card-stack.help')).toContain(
      "grid-template-columns: minmax(0, 1fr);",
    );
    expect(rule('html[data-still-text-scale="large"] .card-stack.help > *')).toContain(
      "grid-column: auto; grid-row: auto;",
    );
  });
});

describe("ruling 11: no divider above Sign out in the app's sync card", () => {
  it("the signed-in card's Sign out group carries no divider or extra space", () => {
    render(SyncCard, {
      props: { account: { address: ACCOUNT.address, confirmed: true, onSignOut: vi.fn() } },
    });
    const group = screen.getByRole("button", { name: "Sign out" }).parentElement!;
    // The popup's own account row is the class "account" (pinned below); this group is not one.
    expect(group).not.toHaveClass("account");
    expect(group).toHaveClass("sync-account");
    const css = source("design/tokens/components.css");
    const rule = css.match(/^\.sync-account \{([^}]*)\}/m)?.[1] ?? "";
    expect(rule).not.toBe("");
    expect(rule).not.toMatch(/border|padding|margin/);
  });

  it("signed in with Still Pro, the same", () => {
    render(SyncCard, {
      props: { stillPro: "account", account: { address: ACCOUNT.address, confirmed: true, holdsPro: true, onSignOut: vi.fn() } },
    });
    const group = screen.getByRole("button", { name: "Sign out" }).parentElement!;
    expect(group).not.toHaveClass("account");
  });
});

// WCAG relative luminance and contrast ratio.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("ruling 12: the green Still Pro User tag reads at 4.5:1 or better", () => {
  const css = source("design/tokens/colors.css");
  // Light :root, dark media block, [data-theme="light"], [data-theme="dark"], in file order.
  const blocks = css.split(/\n(?=:root \{|@media|\[data-theme)/).filter((block) => /--success:/.test(block));
  const value = (block: string, token: string) =>
    block.match(new RegExp(`${token}: (#[0-9a-f]{6});`))?.[1];

  it("pins the success colour in light and dark", () => {
    expect(blocks.map((block) => value(block, "--success"))).toEqual([
      "#145a38",
      "#4fc48a",
      "#145a38",
      "#4fc48a",
    ]);
  });

  it.each([0, 1, 2, 3])("block %i: against the card and the page", (index) => {
    const block = blocks[index]!;
    const green = value(block, "--success")!;
    for (const surface of ["--surface-raised", "--surface"]) {
      const ratio = contrast(green, value(block, surface)!);
      // Light measured about 4.1:1 on screen at 5.7:1 computed; the darker green keeps a margin.
      expect(ratio, `${green} on ${surface}`).toBeGreaterThanOrEqual(
        block.includes("color-scheme: light") ? 7 : 4.5,
      );
    }
  });

  it("the tag draws in the success colour", () => {
    const components = source("design/tokens/components.css");
    expect(components).toMatch(
      /^\.access-tag\.boxed\.success \{ color: var\(--status-success\); border-color: var\(--status-success\); \}/m,
    );
    expect(source("design/tokens/colors.css")).toContain("--status-success: var(--success);");
  });
});

describe("ruling 13: the setup card's heading uses the shared card heading", () => {
  it.each(["ios", "mac"] as const)("Apple app (%s): the same class as Settings sync and Still Pro", async (platform) => {
    const props = await appleProps(platform, false);
    props.setup = {
      title: "Turn on Still in Safari",
      detail: "Still blocks only after you turn it on.",
      steps: ["Open Settings."],
      actionLabel: "Open Settings",
      onAction: vi.fn(),
    };
    render(AppleSettings, { props });
    const heading = screen.getByRole("heading", { name: "Turn on Still in Safari" });
    const sync = screen.getByRole("heading", { name: "Settings sync" });
    expect(heading.tagName).toBe(sync.tagName);
    expect(heading.className).toBe("card-title");
    expect(sync.className).toBe("card-title");
  });
});

describe("ruling 18: no divider above Sign out in the popups' signed-in row", () => {
  it("the V3 popup host clears the account row's divider and the space above it", () => {
    const app = readFileSync(join(here, "../App.svelte"), "utf8");
    const style = app.slice(app.indexOf("<style>"));
    const rule = style.match(/\n {2}\.v3-popup-host\[data-density\] \.account \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("border-block-start: 0;");
    expect(rule).toContain("padding-block-start: 0;");
    expect(rule).toContain("margin-block-start: 0;");
    // The fallback popup's host also carries .app: the compact rule (".app[data-density=...]
    // .account", two classes and an attribute) sets padding-block-start, so the V3 rule must match
    // its specificity and come after it.
    const compact = style.indexOf('\n  .app[data-density="compact"] .account {');
    const v3 = style.indexOf("\n  .v3-popup-host[data-density] .account {");
    expect(compact).toBeGreaterThan(-1);
    expect(v3).toBeGreaterThan(compact);
    for (const [selector, block] of [
      ['.app[data-density="compact"] .account', style.slice(compact)],
      [".v3-popup-host[data-density] .account", style.slice(v3)],
    ] as const) {
      expect(block.slice(0, block.indexOf("}"))).toContain(selector);
      const classes = selector.match(/\.[\w-]+/g)!.length;
      const attributes = selector.match(/\[[^\]]+\]/g)!.length;
      expect(classes + attributes, selector).toBe(3);
    }
  });
});

describe("ruling 4: the popup's signed-out Still Pro tag, level with the heading, above Sign in", () => {
  it("the grid puts the heading and the tag on the first row, centred, and Sign in under the tag", () => {
    const css = source("design/tokens/components.css");
    const rule = (selector: string) =>
      css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
    expect(rule(".sync-row.pro-signed-out")).toContain("display: grid;");
    expect(rule(".sync-row.pro-signed-out")).toContain("align-items: center;");
    expect(rule(".sync-row.pro-signed-out .offer-head")).toBe(" grid-column: 1; grid-row: 1; ");
    expect(rule(".sync-row.pro-signed-out .still-pro-tag")).toContain("grid-column: 2; grid-row: 1;");
    expect(rule(".sync-row.pro-signed-out .popup-action > button")).toBe(" grid-column: 2; grid-row: 2; align-self: start; ");
    expect(rule(".sync-row.pro-signed-out .sync-row-sub")).toBe(" grid-column: 1; grid-row: 2 / span 2; align-self: start; ");
    expect(rule(".sync-row.pro-signed-out .popup-action > .handoff")).toBe(" grid-column: 2; grid-row: 3; ");
    expect(rule(".sync-row.pro-signed-out > .sync-row-text, .sync-row.pro-signed-out > .popup-action")).toBe(
      " display: contents; ",
    );
  });
});

describe("ISS-0095 → B: the Chrome and Firefox popup's Sign out is plain text", () => {
  it("draws in the ink colour with no underline, keeping the shared focus ring", () => {
    const app = readFileSync(join(here, "../App.svelte"), "utf8");
    const style = app.slice(app.indexOf("<style>"));
    const rule = (selector: string) =>
      style.match(new RegExp(`\\n  ${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
    const plain = rule(".v3-popup-host .account .link.plain:not(:disabled)");
    expect(plain).toContain("color: var(--ink);");
    const hover = rule(".v3-popup-host .account .link.plain:not(:disabled):hover");
    expect(hover).toContain("color: var(--ink);");
    expect(hover).toContain("text-decoration: none;");
    // The popup's account row draws Sign out with the plain class only in the V3 popup host.
    expect(app).toMatch(/class="link"\s+class:plain=\{Boolean\(desktopPresentation\)\}\s+onclick=\{\(\) => c\.signOut\(\)\}/);
    expect(source("design/tokens/components.css")).toContain(
      ".still-ui :is(button, a, input):focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 3px; }",
    );
  });
});
