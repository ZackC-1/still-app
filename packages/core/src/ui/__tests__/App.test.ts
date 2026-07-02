import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import App from "../App.svelte";
import Placeholder from "../components/Placeholder.svelte";
import { UiController, type UiAuth, type UiHost } from "../controller.svelte.js";
import { STRINGS } from "../strings.js";
import { PRIVACY_POLICY_URL } from "../config.js";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";

function controller(
  opts: { host?: Partial<UiHost>; globalOn?: boolean; deletable?: boolean; auth?: UiAuth } = {},
) {
  const initial = { ...DEFAULT_SETTINGS, globalOn: opts.globalOn ?? true, updatedAt: 1 };
  const cache = new SettingsCache(new InMemoryStorageAdapter(initial), { initial, now: () => Date.now() });
  return new UiController({
    cache,
    host: { canPurchase: true, currentHost: "youtube.com", ...opts.host },
    auth:
      opts.auth ??
      (opts.deletable
        ? { signIn: () => Promise.resolve({}), signOut: () => Promise.resolve(), deleteAccount: () => Promise.resolve() }
        : undefined),
  });
}

/** An extension-shaped UiAuth: email-OTP code capability, no magic link (plan U2/R1). */
function codeCapableAuth(over: Partial<UiAuth> = {}): UiAuth {
  return {
    signOut: () => Promise.resolve(),
    requestCode: () => Promise.resolve({ kind: "sent" } as const),
    verifyCode: () => Promise.resolve({ kind: "verified", userId: "u" } as const),
    ...over,
  };
}

describe("App", () => {
  it("renders a card for each of the four services", () => {
    render(App, { props: { controller: controller() } });
    expect(document.querySelectorAll("[data-service]").length).toBe(4);
  });

  it("global off visually disables the service group", () => {
    render(App, { props: { controller: controller({ globalOn: false }) } });
    const services = document.querySelector(".services");
    expect(services?.getAttribute("aria-disabled")).toBe("true");
  });

  it("un-entitled users see the three Pro rows locked (no silent no-op toggles)", () => {
    render(App, { props: { controller: controller() } });
    expect(document.querySelectorAll(".card.locked").length).toBe(3); // instagram/tiktok/facebook
    expect(document.querySelector('[data-service="youtube"].locked')).toBeNull(); // free stays a toggle
  });

  it("entitled users get normal toggles on every service", () => {
    const c = controller();
    c.entitled = true;
    render(App, { props: { controller: c } });
    expect(document.querySelectorAll(".card.locked").length).toBe(0);
  });

  it("tapping a lock on a no-purchase host opens the explanatory paywall sheet", async () => {
    const c = controller({ host: { canPurchase: false } });
    render(App, { props: { controller: c } });
    await fireEvent.click(document.querySelector(".lock")!);
    expect(c.paywallOpen).toBe(true);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(STRINGS.paywall.nonApple)).toBeTruthy(); // explanatory, no buy CTA
    expect(dialog.queryByText(STRINGS.paywall.cta)).toBeNull();
  });

  it("not-entitled + can-purchase shows the Unlock Pro CTA", () => {
    const c = controller();
    c.userId = "u";
    render(App, { props: { controller: c } });
    expect(screen.getByText("Unlock Pro")).toBeTruthy();
  });

  it("entitled shows the synced state", () => {
    const c = controller();
    c.userId = "u";
    c.entitled = true;
    render(App, { props: { controller: c } });
    expect(screen.getByText(/Synced across your devices/)).toBeTruthy();
  });

  it("non-Apple host shows the explanatory paywall, never a purchasable CTA (R19)", () => {
    const c = controller({ host: { canPurchase: false } });
    c.userId = "u";
    render(App, { props: { controller: c } });
    expect(screen.queryByText("Unlock Pro")).toBeNull();
    expect(screen.getByText(/Unlock Pro in the Still app/)).toBeTruthy();
  });

  it("Apple host shows the Sign in with Apple CTA, not the email field (U19)", () => {
    render(App, { props: { controller: controller(), onSignInWithApple: () => {} } });
    expect(screen.getByText("Sign in with Apple")).toBeTruthy();
    expect(document.querySelector("input.email")).toBeNull();
  });

  it("Apple host: the sign-in CTA opens the modal; the modal's Apple button fires native sign-in", async () => {
    const onSignInWithApple = vi.fn();
    const c = controller();
    render(App, { props: { controller: c, onSignInWithApple } });
    await fireEvent.click(screen.getByText("Sign in with Apple")); // main CTA → opens the modal
    expect(c.signInOpen).toBe(true);
    const appleButtons = screen.getAllByText("Sign in with Apple"); // main CTA + modal button
    await fireEvent.click(appleButtons[appleButtons.length - 1]!); // the modal's button
    expect(onSignInWithApple).toHaveBeenCalled();
  });

  it("email host: the Sign in CTA opens a modal with the email field (not inline)", async () => {
    const c = controller({ deletable: true }); // any wired auth → the sign-in CTA renders
    render(App, { props: { controller: c } });
    expect(document.querySelector("input.email")).toBeNull(); // not inline in the main UI
    expect(screen.queryByText("Sign in with Apple")).toBeNull();
    await fireEvent.click(screen.getByText("Sign in to sync"));
    expect(c.signInOpen).toBe(true);
    expect(document.querySelector("input.email")).toBeTruthy(); // now in the modal
  });

  it("a host without auth (the extensions, pre-U10) gets no sign-in CTA — only the explanatory note", () => {
    // A "Sign in to sync" button with no auth wired behind it would silently do nothing.
    const c = controller({ host: { canPurchase: false } }); // auth: undefined
    render(App, { props: { controller: c } });
    expect(screen.queryByText("Sign in to sync")).toBeNull();
    expect(screen.queryByText("Sign in with Apple")).toBeNull();
    expect(screen.getByText(STRINGS.paywall.nonApple)).toBeTruthy();
    expect(screen.getByText("Privacy policy")).toBeTruthy(); // store-required link stays reachable
  });

  it("the sign-in sheet does not render once the user is signed in (even if signInOpen lingers)", () => {
    const c = controller();
    c.openSignIn();
    c.userId = "u"; // signed in → popupState leaves "signed-out", so the sheet is gated off
    render(App, { props: { controller: c, onSignInWithApple: () => {} } });
    expect(screen.queryByText(STRINGS.auth.title)).toBeNull(); // the modal title is absent
  });

  // ── email-OTP code entry (plan U2/R1) ──────────────────────────────────────────────────────────

  it("code host: sending a code lands on ONE plain one-time-code input (no segmented boxes)", async () => {
    const c = controller({ auth: codeCapableAuth() });
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText("Sign in to sync"));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(STRINGS.codeAuth.send)).toBeTruthy(); // "Email me a code", not a link
    await c.signIn("a@b.com");
    await tick();
    const input = document.querySelector("input.code") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.getAttribute("type")).toBe("text");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("pattern")).toBe("[0-9]*");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("maxlength")).toBe("6");
    expect(input.getAttribute("aria-label")).toBe(STRINGS.codeAuth.codeLabel);
    expect(screen.getByRole("dialog").querySelectorAll("input").length).toBe(1); // one field only
    const resend = dialog.getByText(/Send a new code in \d+s/) as HTMLButtonElement;
    expect(resend.disabled).toBe(true); // resend blocked during the visible cooldown
    c.dismissSignIn(); // stop the cooldown ticker
  });

  it("code host: the verify button only enables at 6 digits", async () => {
    const c = controller({ auth: codeCapableAuth() });
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText("Sign in to sync"));
    await c.signIn("a@b.com");
    await tick();
    const dialog = within(screen.getByRole("dialog"));
    const verify = dialog.getByText(STRINGS.codeAuth.verify) as HTMLButtonElement;
    expect(verify.disabled).toBe(true); // empty
    const input = document.querySelector("input.code") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "123 456" } }); // full paste, digits kept
    expect(input.value).toBe("123456");
    expect((dialog.getByText(STRINGS.codeAuth.verify) as HTMLButtonElement).disabled).toBe(false);
    c.dismissSignIn();
  });

  it("code host: a send failure renders the code-flow error — never the magic-link copy", async () => {
    const c = controller({
      auth: codeCapableAuth({
        requestCode: () => Promise.resolve({ kind: "send-failed" } as const),
      }),
    });
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText("Sign in to sync"));
    await c.signIn("a@b.com");
    await tick();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(STRINGS.codeAuth.sendError)).toBeTruthy();
    expect(dialog.queryByText(STRINGS.auth.error)).toBeNull();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/link/i); // no "link" in the code path
  });

  // ── account management (App Store 5.1.1) ──────────────────────────────────────────────────────

  it("signed-in (not-entitled) shows the privacy policy link and a Delete account button", () => {
    const c = controller({ deletable: true });
    c.userId = "u";
    render(App, { props: { controller: c } });
    const privacy = screen.getByText("Privacy policy") as HTMLAnchorElement;
    expect(privacy.getAttribute("href")).toBe(PRIVACY_POLICY_URL);
    expect(screen.getByText("Delete account")).toBeTruthy();
  });

  it("signed-in + entitled also shows account management", () => {
    const c = controller({ deletable: true });
    c.userId = "u";
    c.entitled = true;
    render(App, { props: { controller: c } });
    expect(screen.getByText("Privacy policy")).toBeTruthy();
    expect(screen.getByText("Delete account")).toBeTruthy();
  });

  it("signed-out shows the privacy link but no Delete account (no account yet)", () => {
    render(App, { props: { controller: controller({ deletable: true }) } });
    expect(screen.queryByText("Delete account")).toBeNull();
    expect(screen.getByText("Privacy policy")).toBeTruthy();
  });

  it("Delete account opens a destructive confirm with confirm + cancel", async () => {
    const c = controller({ deletable: true });
    c.userId = "u";
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText("Delete account"));
    expect(screen.getByText(/permanently deletes your account/)).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("host without deleteAccount shows privacy link but no Delete button", () => {
    const c = controller({ deletable: false });
    c.userId = "u";
    render(App, { props: { controller: c } });
    expect(screen.getByText("Privacy policy")).toBeTruthy();
    expect(screen.queryByText("Delete account")).toBeNull();
  });

  // ── paywall purchase outcomes (P1 #5) ──────────────────────────────────────────────────────────

  it("a non-purchased outcome keeps the sheet open with a message", () => {
    const c = controller();
    c.userId = "u";
    c.openPaywall();
    c.setPurchaseOutcome({ outcome: "cancelled", entitled: false });
    render(App, { props: { controller: c, onGet: () => {} } });
    expect(screen.getByRole("dialog")).toBeTruthy(); // still open
    expect(screen.getByText("Purchase cancelled.")).toBeTruthy();
  });

  it("the buy CTA shows the localized store price when loaded, and no price otherwise", () => {
    const withPrice = controller();
    withPrice.userId = "u";
    withPrice.openPaywall();
    withPrice.paywallPrice = "£1.99";
    const { unmount } = render(App, { props: { controller: withPrice, onGet: () => {} } });
    expect(within(screen.getByRole("dialog")).getByText(/Unlock Pro · £1\.99/)).toBeTruthy();
    unmount();

    const noPrice = controller();
    noPrice.userId = "u";
    noPrice.openPaywall(); // paywallPrice stays null (price not loaded / non-Apple)
    render(App, { props: { controller: noPrice, onGet: () => {} } });
    const cta = within(screen.getByRole("dialog")).getByText("Unlock Pro");
    expect(cta.textContent).not.toContain("·"); // no hardcoded/guessed price
  });

  it("the Get button is disabled while a purchase is in flight (duplicate-tap guard)", async () => {
    const onGet = vi.fn();
    const c = controller();
    c.userId = "u";
    c.openPaywall();
    c.paywallPrice = "$1.99";
    render(App, { props: { controller: c, onGet } });
    const dialog = within(screen.getByRole("dialog"));
    await fireEvent.click(dialog.getByText(/Unlock Pro ·/)); // the paywall CTA (has the price)
    expect(onGet).toHaveBeenCalledOnce();
    const inFlight = dialog.getByText(/Completing your purchase/) as HTMLButtonElement;
    expect(inFlight.disabled).toBe(true);
    await fireEvent.click(inFlight);
    expect(onGet).toHaveBeenCalledOnce(); // second tap ignored (button disabled)
  });

  it("pending purchase keeps the sheet open with the Ask-to-Buy note", () => {
    const c = controller();
    c.userId = "u";
    c.openPaywall();
    c.setPurchaseOutcome({ outcome: "pending", entitled: false });
    render(App, { props: { controller: c, onGet: () => {} } });
    expect(screen.getByText(/Waiting for approval/)).toBeTruthy();
  });
});

describe("Placeholder", () => {
  it("renders one calm line and no buttons (no scolding)", () => {
    render(Placeholder, { props: {} });
    expect(screen.getByText(/Nothing here/)).toBeTruthy();
    expect(document.querySelectorAll("button").length).toBe(0);
  });
});
