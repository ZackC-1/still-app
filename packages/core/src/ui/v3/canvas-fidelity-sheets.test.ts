import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import SignInSheet from "../components/SignInSheet.svelte";
import ConfirmationDialog from "./ConfirmationDialog.svelte";

// The sign-in sheets, the Delete your account? dialog and the checkout return page against the
// owner's screens canvas ("Sheets" and "Checkout return" pages, fidelity check of 22 Oct 2026).
// jsdom computes no layout, so the sizes are pinned in the stylesheets the screens use; the
// rendered tests pin what the markup decides (which host, which class).

afterEach(cleanup);

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(join(here, file), "utf8");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The declarations of one rule, `selector {` at a line start, in a stylesheet or a <style> block. */
const rule = (css: string, selector: string) =>
  css.match(new RegExp(`^\\s*${escape(selector)} \\{([^}]*)\\}`, "m"))?.[1] ?? "";

function controller(step: "email" | "code" | "consent") {
  return {
    signInOpen: true,
    popupState: "signed-out",
    emailConsent: step === "consent" ? "opt-in" : "none",
    needsEmailConsent: step === "consent",
    canUseCode: true,
    authFlow: step === "code" ? "code-entry" : "idle",
    codeEmail: "person@still.test",
    verifyBlockRemaining: 0,
    codeErrorKind: null,
    suggestNewCode: false,
    resendCooldown: 0,
    sendBlockRemaining: 0,
    authError: null,
    acceptEmailConsent: vi.fn(),
    verifyCode: vi.fn(),
    resendCode: vi.fn(),
    useDifferentEmail: vi.fn(),
    signIn: vi.fn(),
    dismissSignIn: vi.fn(),
  } as never;
}

describe("sign-in sheet (Sheet-ApplePurchase, -AppleCode, -AppleSync, -AppleSyncCode, -Browser*)", () => {
  const sheet = () => source("../components/SignInSheet.svelte");
  const style = () => sheet().slice(sheet().indexOf("<style>"));

  it("says which host opened it: the Apple app's buttons are 54px, the browsers' 44px", () => {
    render(SignInSheet, { controller: controller("email"), onDismiss: vi.fn(), host: "apple" });
    expect(screen.getByRole("dialog").parentElement).toHaveAttribute("data-host", "apple");
    cleanup();
    render(SignInSheet, { controller: controller("email"), onDismiss: vi.fn() });
    expect(screen.getByRole("dialog").parentElement).toHaveAttribute("data-host", "browser");
    expect(rule(style(), ".primary")).toContain("min-block-size: 44px;");
    expect(rule(style(), '.layer[data-host="apple"] .primary')).toContain("min-block-size: 54px;");
    expect(source("../../../../app-webview/src/AppleSettingsHost.svelte")).toMatch(
      /<SignInSheet\s+controller=\{c\}\s+host="apple"/,
    );
  });

  it("draws the canvas panel: 10/20/28 padding, ink text, 20px title, 15px lines, 5px grip", () => {
    const panel = rule(style(), ".sheet");
    expect(panel).toContain("padding: 10px 20px calc(28px + env(safe-area-inset-bottom));");
    expect(panel).toContain("color: var(--ink);");
    expect(panel).toContain("box-shadow: 0 -8px 30px rgba(0, 0, 0, 0.18);");
    expect(rule(style(), ".sheet h2")).toContain("font-size: calc(20px * var(--text-scale, 1));");
    expect(rule(style(), ".sheet h2")).toContain("letter-spacing: normal;");
    expect(rule(style(), ".body")).toContain("font-size: calc(15px * var(--text-scale, 1));");
    expect(rule(style(), ".grip")).toContain("block-size: 5px;");
    expect(rule(style(), ".grip")).toContain("background: var(--border-strong);");
    expect(rule(style(), ".grip")).not.toContain("margin");
    // The label sits a full 12px gap above its field, not pulled to 4px.
    expect(rule(style(), ".field-label")).not.toContain("margin");
    expect(rule(style(), ":global([data-theme=\"dark\"]) .sheet")).toContain(
      "--sheet-surface: var(--surface-raised);",
    );
  });

  // The fields keep PR #549's --input-border (3:1 against the panel) rather than the canvas's
  // fainter --border-strong; see R15 in the lane D report.
  it("draws the fields 48px tall with the contrasting border; the code field at 20px", () => {
    expect(rule(style(), ".email,\n  .code")).toContain("min-block-size: 48px;");
    expect(rule(style(), ".email,\n  .code")).toContain("border: 1px solid var(--input-border);");
    expect(rule(style(), ".email,\n  .code")).toContain("padding: 10px 14px;");
    expect(style()).toMatch(/\.code \{\s*font-size: calc\(20px \* var\(--text-scale, 1\)\);\s*letter-spacing: 0\.3em;/);
    expect(rule(style(), ".sent")).toContain("font-size: calc(14px * var(--text-scale, 1));");
  });

  it("centres the secondary actions in blue: 44px, and 36px at 15px on the code step", () => {
    const links = rule(style(), ".link,\n  .dismiss");
    expect(links).toContain("align-self: center;");
    expect(links).toContain("min-block-size: 44px;");
    expect(links).toContain("color: var(--link, var(--still-blue));");
    expect(rule(style(), ".link.code-step")).toContain("min-block-size: 36px;");
    expect(rule(style(), ".link.code-step")).toContain("font-size: calc(15px * var(--text-scale, 1));");
    render(SignInSheet, { controller: controller("code"), onDismiss: vi.fn() });
    expect(screen.getByRole("button", { name: "Send a new code" })).toHaveClass("code-step");
    expect(screen.getByRole("button", { name: "Use a different email" })).toHaveClass("code-step");
  });

  it("keeps the purchase note and Buy without an account on the email step only (owner ruling D5)", () => {
    const skip = { label: "Buy without an account", onSkip: vi.fn() };
    const note = "Sign in first to keep Still Pro with your account.";
    render(SignInSheet, { controller: controller("email"), onDismiss: vi.fn(), host: "apple", note, skip });
    expect(screen.getByText(note)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buy without an account" })).toBeInTheDocument();
    cleanup();
    render(SignInSheet, { controller: controller("code"), onDismiss: vi.fn(), host: "apple", note, skip });
    expect(screen.queryByText(note)).toBeNull();
    expect(screen.queryByRole("button", { name: "Buy without an account" })).toBeNull();
    expect(screen.getByLabelText("6-digit code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("asks for the 6-digit sign-in code on the code step (ruling D6, P3-9)", () => {
    render(SignInSheet, { controller: controller("code"), onDismiss: vi.fn() });
    expect(screen.getByText("Check your email for a 6-digit sign-in code.")).toBeInTheDocument();
  });

  it("gives Firefox's agreement a 20px box and 15px words, and a disabled Continue at half strength", () => {
    expect(rule(style(), ".agree")).toContain("gap: 10px;");
    expect(rule(style(), ".agree")).toContain("font-size: calc(15px * var(--text-scale, 1));");
    expect(rule(style(), ".agree input")).toContain("inline-size: 20px;");
    expect(rule(style(), "button:disabled")).toContain("opacity: 0.5;");
  });

  it("is 480px wide at most on a wide page, as on the Settings-page canvas", () => {
    expect(source("design/tokens/spacing.css")).toContain("--sheet-max-inline-size: 480px;");
    expect(source("../tokens.css")).toContain("--sheet-max-inline-size: 480px;");
  });
});

describe("Delete your account? (Sheet-Delete, P-DeleteDialog)", () => {
  const css = () => source("design/tokens/components.css");

  it("sits 24px from the screen's sides with 20px padding, 14px gaps and a 19px title", () => {
    const dialog = rule(css(), ".dialog");
    expect(dialog).toContain("inline-size: min(calc(100% - 48px), var(--dialog-max-inline-size, 360px));");
    expect(dialog).toContain("padding: 20px;");
    expect(dialog).toContain("gap: 14px;");
    expect(dialog).toContain("box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);");
    expect(dialog).toContain("border-radius: var(--radius-sheet);");
    expect(rule(css(), ".dialog h2")).toContain("font-size: calc(19px * var(--text-scale, 1));");
    expect(rule(css(), ".dialog-actions .secondary")).toContain("border-color: var(--border-strong);");
    expect(rule(css(), ".scrim")).toContain("background: rgba(11, 20, 48, 0.5);");
  });

  it("makes both buttons 54px in the Apple apps and 44px in the browsers", () => {
    expect(rule(css(), ".dialog-actions > button")).toContain("min-block-size: var(--tap-target);");
    expect(rule(css(), ".dialog-actions > button")).toContain("padding-block: 0;");
    expect(rule(css(), '[data-host="apple"] .dialog-actions > button')).toContain("min-block-size: 54px;");
    render(ConfirmationDialog, {
      open: true,
      title: "Delete your account?",
      body: "Body",
      confirmLabel: "Delete account",
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(screen.getByRole("button", { name: "Delete account" }).parentElement).toHaveClass(
      "dialog-actions",
    );
  });
});

describe("checkout return page (Checkout-Confirming, -Ready, -Unconfirmed, -Cancelled)", () => {
  it("uses the canvas column, title, status lines, 44px button and 14px footer", () => {
    const css = source("checkout-return-layout.css");
    const scoped = (selector: string) =>
      css.match(new RegExp(`^${escape(selector)}\\{([^}]*)\\}`, "m"))?.[1] ?? "";
    expect(scoped(".checkout-return .fr-col")).toBe("max-width:520px;padding:64px 16px 32px;gap:20px");
    expect(scoped(".checkout-return .fr-col h1")).toContain("font-size:calc(30px * var(--text-scale, 1))");
    expect(scoped(".checkout-return .status-line")).toContain("font-size:calc(15px * var(--text-scale, 1))");
    expect(scoped(".checkout-return .primary.block")).toContain("min-block-size:44px");
    expect(scoped(".checkout-return .fr-foot")).toContain("gap:8px 24px");
    expect(scoped(".checkout-return .fr-foot")).toContain("font-size:calc(14px * var(--text-scale, 1))");
    expect(source("CheckoutReturn.svelte")).toContain('<main class="still-ui fr checkout-return">');
  });
});
