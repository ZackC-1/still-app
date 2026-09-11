import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { DEFAULT_SETTINGS, PAID_TIER_ENABLED } from "@still/shared-types";
import App from "../App.svelte";
import Placeholder from "../components/Placeholder.svelte";
import {
  UiController,
  type UiCheckout,
  type UiAuth,
  type UiHost,
} from "../controller.svelte.js";
import { STRINGS } from "../strings.js";
import { PRIVACY_POLICY_URL } from "../config.js";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";

const paidTierIt = it.runIf(PAID_TIER_ENABLED);
const includedAccessIt = it.runIf(!PAID_TIER_ENABLED);

function controller(
  opts: {
    host?: Partial<UiHost>;
    globalOn?: boolean;
    services?: Partial<(typeof DEFAULT_SETTINGS)["services"]>;
    deletable?: boolean;
    auth?: UiAuth;
    checkout?: UiCheckout;
  } = {},
) {
  const initial = {
    ...DEFAULT_SETTINGS,
    globalOn: opts.globalOn ?? true,
    services: { ...DEFAULT_SETTINGS.services, ...opts.services },
    updatedAt: 1,
  };
  const cache = new SettingsCache(new InMemoryStorageAdapter(initial), {
    initial,
    now: () => Date.now(),
  });
  return new UiController({
    cache,
    host: { canPurchase: true, ...opts.host },
    checkout: opts.checkout,
    auth:
      opts.auth ??
      (opts.deletable
        ? {
            signIn: () => Promise.resolve({}),
            signOut: () => Promise.resolve(),
            deleteAccount: () => Promise.resolve(),
          }
        : undefined),
  });
}

/** A minimal web-checkout seam: its presence is what makes a host "web-shaped" — the sign-in-
 * first upgrade path applies only to these hosts (the account is the delivery identity there).
 * Native-purchase hosts (Apple: canPurchase, NO seam) go straight to the paywall (R1). */
function checkoutStub(): UiCheckout {
  return {
    createCheckout: () => Promise.resolve({ kind: "unavailable" } as const),
    openCheckoutTab: () => Promise.resolve(undefined),
    setPending: () => {},
    reconcile: () => Promise.resolve("unknown" as const),
  };
}

/** An extension-shaped UiAuth: email-OTP code capability, no magic link (plan U2/R1). */
function codeCapableAuth(over: Partial<UiAuth> = {}): UiAuth {
  return {
    signOut: () => Promise.resolve(),
    requestCode: () => Promise.resolve({ kind: "sent" } as const),
    verifyCode: () =>
      Promise.resolve({ kind: "verified", userId: "u" } as const),
    ...over,
  };
}

describe("App", () => {
  includedAccessIt("shows live toggles and no upgrade CTA while the paid tier is off", () => {
    expect(PAID_TIER_ENABLED).toBe(false);
    render(App, { props: { controller: controller({ auth: codeCapableAuth() }) } });

    expect(document.querySelectorAll(".card.locked")).toHaveLength(0);
    expect(screen.queryByText(STRINGS.paywall.upgradeCta)).toBeNull();
    expect(screen.getByText(STRINGS.auth.signInCta)).toBeTruthy();
  });

  it("exposes an explicit compact density for constrained extension panels", () => {
    render(App, { props: { controller: controller(), compact: true } });

    expect(document.querySelector(".app")?.getAttribute("data-density")).toBe(
      "compact",
    );
  });

  it("renders a card for each of the four services", () => {
    render(App, { props: { controller: controller() } });
    expect(document.querySelectorAll("[data-service]").length).toBe(4);
  });

  it("renders host-supplied guidance for finding Still on that surface", () => {
    render(App, {
      props: {
        controller: controller(),
        surfaceGuidance: {
          title: "Find Still in a test browser",
          body: "Use this browser's extension menu.",
        },
      },
    });

    expect(
      screen.getByRole("heading", { name: "Find Still in a test browser" }),
    ).toBeTruthy();
    expect(screen.getByText("Use this browser's extension menu.")).toBeTruthy();
  });

  it("renders no guidance card when the host supplies none", () => {
    render(App, { props: { controller: controller() } });
    expect(document.querySelector(".guidance")).toBeNull();
  });

  it("global off visually disables the service group", () => {
    render(App, { props: { controller: controller({ globalOn: false }) } });
    const services = document.querySelector(".services");
    expect(services?.getAttribute("aria-disabled")).toBe("true");
    const youtubeSwitch = within(
      document.querySelector('[data-service="youtube"]') as HTMLElement,
    ).getByRole("switch") as HTMLButtonElement;
    expect(youtubeSwitch.disabled).toBe(true);
  });

  paidTierIt("global off also disables a locked service's lock button", () => {
    render(App, { props: { controller: controller({ globalOn: false }) } });
    const lock = document.querySelector(
      '[data-service="instagram"] .lock',
    ) as HTMLButtonElement;
    expect(lock.disabled).toBe(true);
  });

  paidTierIt("un-entitled users see the three Pro rows locked (no silent no-op toggles)", () => {
    render(App, { props: { controller: controller() } });
    expect(screen.getByText(STRINGS.global.onFree)).toBeTruthy();
    expect(document.querySelectorAll(".card.locked").length).toBe(3); // instagram/tiktok/facebook
    expect(document.querySelectorAll(".card.locked .lock svg").length).toBe(3);
    expect(
      document.querySelector(".card.locked .lock")?.textContent?.trim(),
    ).toBe("");
    expect(
      document.querySelector('[data-service="youtube"].locked'),
    ).toBeNull(); // free stays a toggle
  });

  it("entitled users get normal toggles on every service", () => {
    const c = controller();
    c.entitled = true;
    render(App, { props: { controller: c } });
    expect(screen.getByText(STRINGS.global.onSecondary)).toBeTruthy();
    expect(document.querySelectorAll(".card.locked").length).toBe(0);
  });

  it("global off does not claim that Shorts are currently removed", () => {
    render(App, { props: { controller: controller({ globalOn: false }) } });
    expect(screen.getByText(STRINGS.global.offSecondary)).toBeTruthy();
  });

  paidTierIt("free user with the YouTube row off does not claim Shorts are removed", () => {
    render(App, {
      props: { controller: controller({ services: { youtube: false } }) },
    });
    expect(screen.getByText(STRINGS.global.onFreeYoutubeOff)).toBeTruthy();
    expect(screen.queryByText(STRINGS.global.onFree)).toBeNull();
  });

  includedAccessIt("one hero line covers everyone, whichever rows are on", () => {
    // "On enabled sites" is already true of any combination of rows, so there is no state where
    // the hero has to hedge or name a service someone cannot have.
    for (const youtube of [true, false]) {
      const view = render(App, {
        props: { controller: controller({ services: { youtube } }) },
      });
      expect(screen.getByText(STRINGS.global.onSecondary)).toBeTruthy();
      expect(screen.queryByText(/Still Pro/)).toBeNull();
      view.unmount();
    }
  });

  paidTierIt("tapping a lock on a no-purchase host opens the explanatory paywall sheet", async () => {
    const c = controller({ host: { canPurchase: false } });
    render(App, { props: { controller: c } });
    await fireEvent.click(document.querySelector(".lock")!);
    expect(c.paywallOpen).toBe(true);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(STRINGS.paywall.nonApple)).toBeTruthy(); // explanatory, no buy CTA
    expect(dialog.queryByText(STRINGS.paywall.cta)).toBeNull();
  });

  paidTierIt("not-entitled + can-purchase shows the upgrade CTA and it opens the paywall", async () => {
    const c = controller();
    c.userId = "u";
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.paywall.upgradeCta));
    expect(c.paywallOpen).toBe(true);
    expect(c.signInOpen).toBe(false); // signed in: straight to the paywall, no re-auth detour
  });

  it("a signed-in user is told their settings are syncing", () => {
    const c = controller();
    c.userId = "u";
    c.entitled = true;
    render(App, { props: { controller: c } });
    expect(screen.getByText(STRINGS.sync.syncing)).toBeTruthy();
  });

  includedAccessIt("signing in is offered as what it is: settings sync, and optional", () => {
    render(App, { props: { controller: controller({ auth: codeCapableAuth() }) } });
    expect(screen.getByText(STRINGS.sync.sectionTitle)).toBeTruthy();
    expect(screen.getByText(STRINGS.sync.signedOut)).toBeTruthy();
    expect(screen.getByText(STRINGS.auth.signInCta)).toBeTruthy();
    // Nothing here may imply that blocking depends on it.
    expect(screen.queryByText(STRINGS.paywall.upgradeCta)).toBeNull();
    expect(document.querySelectorAll(".card.locked")).toHaveLength(0);
  });

  paidTierIt("non-Apple host shows the explanatory paywall, never a purchasable CTA (R19)", () => {
    const c = controller({ host: { canPurchase: false } });
    c.userId = "u";
    render(App, { props: { controller: c } });
    expect(screen.queryByText(STRINGS.paywall.upgradeCta)).toBeNull();
    expect(screen.getByText(/Unlock Pro in the Still app/)).toBeTruthy();
  });

  includedAccessIt("a signed-in free user is never pointed at a purchase, on any host", () => {
    // The line below was written for a surface that could not sell anything and had to explain
    // where to buy. With nothing to buy anywhere, it would tell people to go to the app they are
    // already inside, so this state shows nothing in its place.
    for (const canPurchase of [true, false]) {
      const c = controller({ host: { canPurchase }, auth: codeCapableAuth() });
      c.userId = "u";
      const view = render(App, { props: { controller: c } });
      expect(c.popupState).toBe("entitled-syncing"); // signed in is signed in; nothing is gated
      expect(screen.queryByText(STRINGS.paywall.upgradeCta)).toBeNull();
      expect(screen.queryByText(/Unlock Pro in the Still app/)).toBeNull();
      expect(screen.getByText(STRINGS.sync.syncing)).toBeTruthy();
      expect(screen.getByText(STRINGS.auth.signOut)).toBeTruthy();
      view.unmount();
    }
  });

  it("Apple host prop is ignored: shared UI does not render Sign in with Apple", async () => {
    const onSignInWithApple = vi.fn();
    const c = controller({ auth: codeCapableAuth() });
    render(App, { props: { controller: c, onSignInWithApple } });
    expect(screen.queryByText("Sign in with Apple")).toBeNull();
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    expect(c.signInOpen).toBe(true);
    expect(document.querySelector("input.email")).toBeTruthy();
    expect(screen.queryByText("Sign in with Apple")).toBeNull();
    expect(onSignInWithApple).not.toHaveBeenCalled();
  });

  it("email host: the Sign in CTA opens a modal with the email field (not inline)", async () => {
    const c = controller({ deletable: true }); // any wired auth → the sign-in CTA renders
    render(App, { props: { controller: c } });
    expect(document.querySelector("input.email")).toBeNull(); // not inline in the main UI
    expect(screen.queryByText("Sign in with Apple")).toBeNull();
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    expect(c.signInOpen).toBe(true);
    expect(document.querySelector("input.email")).toBeTruthy(); // now in the modal
  });

  it("the sign-in form exposes native email metadata and a visible label", async () => {
    const c = controller({ auth: codeCapableAuth() });
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));

    const email = screen.getByLabelText(
      STRINGS.auth.emailLabel,
    ) as HTMLInputElement;
    expect(email.name).toBe("email");
    expect(email.autocomplete).toBe("email");
    expect(email.getAttribute("spellcheck")).toBe("false");
    expect(email.getAttribute("autocapitalize")).toBe("none");
  });

  it("the sign-in dialog traps reverse tab navigation and has a semantic backdrop", async () => {
    const c = controller({ auth: codeCapableAuth() });
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    await tick();

    const dialog = screen.getByRole("dialog");
    const email = screen.getByLabelText(STRINGS.auth.emailLabel);
    expect(document.activeElement).toBe(email);
    await fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      within(dialog).getByText(STRINGS.auth.cancel),
    );
    expect(
      screen.getByRole("button", { name: STRINGS.auth.dismissLabel }),
    ).toBeTruthy();
  });

  it("a host without auth gets no sign-in CTA, only a plain note about where settings live", () => {
    // The Safari extension popup. A sign-in button with no auth wired behind it would silently do
    // nothing, and App Store Review Guideline 4.4 keeps an invitation to create an account out of
    // an extension, so the note states the fact and the host app carries the invitation.
    const c = controller({ host: { canPurchase: false } }); // auth: undefined
    render(App, { props: { controller: c } });
    expect(screen.queryByText(STRINGS.auth.signInCta)).toBeNull();
    expect(screen.queryByText("Sign in with Apple")).toBeNull();
    expect(
      screen.getByText(PAID_TIER_ENABLED ? STRINGS.paywall.nonApple : STRINGS.sync.deviceOnly),
    ).toBeTruthy();
    expect(screen.getByText("Privacy policy")).toBeTruthy(); // store-required link stays reachable
  });

  it("the sign-in sheet does not render once the user is signed in (even if signInOpen lingers)", () => {
    const c = controller();
    c.openSignIn();
    c.userId = "u"; // signed in → popupState leaves "signed-out", so the sheet is gated off
    render(App, { props: { controller: c, onSignInWithApple: () => {} } });
    expect(screen.queryByText(STRINGS.auth.title)).toBeNull(); // the modal title is absent
  });

  paidTierIt("signed-out home screen shows sign-in and upgrade, with auth copy only in the sheet", async () => {
    const c = controller({ auth: codeCapableAuth() });
    render(App, { props: { controller: c } });
    expect(screen.getByText(STRINGS.auth.signInCta)).toBeTruthy();
    expect(screen.getByText(STRINGS.paywall.upgradeCta)).toBeTruthy();
    expect(screen.queryByText(STRINGS.auth.prompt)).toBeNull();
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    expect(
      within(screen.getByRole("dialog")).getByText(STRINGS.auth.prompt),
    ).toBeTruthy();
  });

  paidTierIt("makes the signed-out Still Pro path primary while keeping restore sign-in available", () => {
    const c = controller({ auth: codeCapableAuth() });
    render(App, { props: { controller: c } });
    const accountCard = document.querySelector("section.sync");
    expect(accountCard).toBeTruthy();
    const buttons = within(accountCard as HTMLElement).getAllByRole("button");
    expect(buttons[0]?.textContent).toBe(STRINGS.paywall.upgradeCta);
    expect(buttons[0]?.classList.contains("primary")).toBe(true);
    expect(buttons[1]?.textContent).toBe(STRINGS.auth.signInCta);
    expect(buttons[1]?.classList.contains("secondary")).toBe(true);
  });

  paidTierIt("signed-in non-Pro users see upgrade and account controls", () => {
    const c = controller({ deletable: true });
    c.userId = "u";
    render(App, { props: { controller: c } });
    expect(screen.getByText(STRINGS.paywall.upgradeCta)).toBeTruthy();
    expect(screen.getByText("Sign out")).toBeTruthy();
    expect(screen.getByText("Privacy policy")).toBeTruthy();
    expect(screen.getByText("Delete account")).toBeTruthy();
  });

  it("a signed-in user is not asked to sign in again, or to buy anything", () => {
    const c = controller({ auth: codeCapableAuth(), deletable: true });
    c.userId = "u";
    c.entitled = true;
    render(App, { props: { controller: c } });
    expect(screen.queryByText(STRINGS.auth.signInCta)).toBeNull();
    expect(screen.queryByText(STRINGS.paywall.upgradeCta)).toBeNull();
    expect(screen.getByText(STRINGS.sync.syncing)).toBeTruthy();
  });

  paidTierIt("signed-out upgrade records intent and opens email-code sign-in before paywall (web-checkout host)", async () => {
    const c = controller({ auth: codeCapableAuth(), checkout: checkoutStub() });
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.paywall.upgradeCta));
    expect(c.purchaseIntent).toBe(true);
    expect(c.signInOpen).toBe(true);
    expect(c.paywallOpen).toBe(false);
    expect(document.querySelector("input.email")).toBeTruthy();
  });

  paidTierIt("locked Pro rows do not toggle and route signed-out users to sign-in (web-checkout host)", async () => {
    const c = controller({ auth: codeCapableAuth(), checkout: checkoutStub() });
    render(App, { props: { controller: c } });
    const instagram = document.querySelector('[data-service="instagram"]')!;
    expect(within(instagram as HTMLElement).queryByRole("switch")).toBeNull();
    await fireEvent.click(within(instagram as HTMLElement).getByRole("button"));
    expect(c.purchaseIntent).toBe(true);
    expect(c.signInOpen).toBe(true);
    expect(c.paywallOpen).toBe(false);
  });

  // ── email-OTP code entry (plan U2/R1) ──────────────────────────────────────────────────────────

  it("code host: sending a code lands on ONE plain one-time-code input (no segmented boxes)", async () => {
    const c = controller({ auth: codeCapableAuth() });
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
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
    const resend = dialog.getByText(
      /Send a new code in \d+s/,
    ) as HTMLButtonElement;
    expect(resend.disabled).toBe(true); // resend blocked during the visible cooldown
    c.dismissSignIn(); // stop the cooldown ticker
  });

  it("code host: the verify button only enables at 6 digits", async () => {
    const c = controller({ auth: codeCapableAuth() });
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    await c.signIn("a@b.com");
    await tick();
    const dialog = within(screen.getByRole("dialog"));
    const verify = dialog.getByText(
      STRINGS.codeAuth.verify,
    ) as HTMLButtonElement;
    expect(verify.disabled).toBe(true); // empty
    const input = document.querySelector("input.code") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "123 456" } }); // full paste, digits kept
    expect(input.value).toBe("123456");
    expect(
      (dialog.getByText(STRINGS.codeAuth.verify) as HTMLButtonElement).disabled,
    ).toBe(false);
    c.dismissSignIn();
  });

  it("code host: a send failure renders the code-flow error — never the magic-link copy", async () => {
    const c = controller({
      auth: codeCapableAuth({
        requestCode: () => Promise.resolve({ kind: "send-failed" } as const),
      }),
    });
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    await c.signIn("a@b.com");
    await tick();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(STRINGS.codeAuth.sendError)).toBeTruthy();
    expect(dialog.queryByText(STRINGS.auth.error)).toBeNull();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/link/i); // no "link" in the code path
  });

  it("a rate-limited first send renders wait copy with the CTA locked — never an existing-code claim (AE1)", async () => {
    const c = controller({
      auth: codeCapableAuth({
        requestCode: () => Promise.resolve({ kind: "send-rate-limited" } as const),
      }),
    });
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    await c.signIn("a@b.com");
    await tick();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(new RegExp(STRINGS.codeAuth.sendBlocked.slice(0, 20)))).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/inbox|already/i); // no code exists to point at
    const send = dialog.getByText(STRINGS.codeAuth.send) as HTMLButtonElement;
    expect(send.disabled).toBe(true); // locked, not "try again"
    c.dismissSignIn();
  });

  it("a rate-limited verify locks the verify button and outranks request-a-new-code (AE3)", async () => {
    const c = controller({
      auth: codeCapableAuth({
        verifyCode: () => Promise.resolve({ kind: "verify-rate-limited" } as const),
      }),
    });
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    await c.signIn("a@b.com");
    await tick();
    const input = document.querySelector("input.code") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "123456" } });
    await c.verifyCode("123456");
    await tick();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(new RegExp(STRINGS.codeAuth.verifyBlocked))).toBeTruthy();
    expect(dialog.queryByText(STRINGS.codeAuth.requestNew)).toBeNull();
    const verify = dialog.getByText(STRINGS.codeAuth.verify) as HTMLButtonElement;
    expect(verify.disabled).toBe(true);
    c.dismissSignIn();
  });

  it("a rate-limited resend renders the code-view wait copy (the sent code still works) with resend locked (AE2)", async () => {
    const c = controller({ auth: codeCapableAuth() });
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    await c.signIn("a@b.com");
    await tick();
    // Drive the post-429 state directly (the transition itself is pinned in controller.test.ts);
    // this pin is about the RENDER: the code-view line may reference the already-sent code, and
    // the resend button obeys the lock countdown.
    c.codeErrorKind = "resend-rate-limited";
    c.sendBlockRemaining = 90; // longer than the 60s post-send cooldown — the lock must win the countdown
    await tick();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(STRINGS.codeAuth.resendBlocked)).toBeTruthy();
    const resend = dialog.getByText(new RegExp(STRINGS.codeAuth.resendWait)) as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    expect(resend.textContent).toContain("90s");
    c.dismissSignIn();
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
    expect(screen.getByText(STRINGS.account.deleteConfirmBody)).toBeTruthy();
    expect(screen.getByText(STRINGS.account.deleteCancel)).toBeTruthy();
  });

  it("host without deleteAccount shows privacy link but no Delete button", () => {
    const c = controller({ deletable: false });
    c.userId = "u";
    render(App, { props: { controller: c } });
    expect(screen.getByText("Privacy policy")).toBeTruthy();
    expect(screen.queryByText("Delete account")).toBeNull();
  });

  // ── paywall purchase outcomes (P1 #5) ──────────────────────────────────────────────────────────

  paidTierIt("a non-purchased outcome keeps the sheet open with a message", () => {
    const c = controller();
    c.userId = "u";
    c.openPaywall();
    c.setPurchaseOutcome({ outcome: "cancelled", entitled: false });
    render(App, { props: { controller: c, onGet: () => {} } });
    expect(screen.getByRole("dialog")).toBeTruthy(); // still open
    expect(screen.getByText("Purchase cancelled.")).toBeTruthy();
  });

  paidTierIt("the buy CTA shows the localized store price when loaded, and no price otherwise", () => {
    const withPrice = controller();
    withPrice.userId = "u";
    withPrice.openPaywall();
    withPrice.paywallPrice = "£1.99";
    const { unmount } = render(App, {
      props: { controller: withPrice, onGet: () => {} },
    });
    expect(
      within(screen.getByRole("dialog")).getByText(/Get Still Pro · £1\.99/),
    ).toBeTruthy();
    unmount();

    const noPrice = controller();
    noPrice.userId = "u";
    noPrice.openPaywall(); // paywallPrice stays null (price not loaded / non-Apple)
    render(App, { props: { controller: noPrice, onGet: () => {} } });
    const cta = within(screen.getByRole("dialog")).getByText("Get Still Pro");
    expect(cta.textContent).not.toContain("·"); // no hardcoded/guessed price
  });

  paidTierIt("pending purchase keeps the sheet open with the Ask-to-Buy note", () => {
    const c = controller();
    c.userId = "u";
    c.openPaywall();
    c.setPurchaseOutcome({ outcome: "pending", entitled: false });
    render(App, { props: { controller: c, onGet: () => {} } });
    expect(screen.getByText(/Waiting for approval/)).toBeTruthy();
  });

  paidTierIt("the paywall leads with the ratified headline and reassurance (D6)", () => {
    const c = controller();
    c.userId = "u";
    c.openPaywall();
    render(App, { props: { controller: c, onGet: () => {} } });
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(STRINGS.paywall.headline)).toBeTruthy();
    expect(dialog.getByText(STRINGS.paywall.reassurance)).toBeTruthy();
  });

  paidTierIt("discloses the Safari-only mobile boundary before purchase", () => {
    const c = controller();
    c.userId = "u";
    c.openPaywall();
    render(App, { props: { controller: c, onGet: () => {} } });
    const dialog = within(screen.getByRole("dialog"));
    expect(
      dialog.getByText(
        "On iPhone and iPad, Still works in Safari only. It does not block short-form video inside native apps.",
      ),
    ).toBeTruthy();
  });

  // ── success payoff (plan U3/R6) ────────────────────────────────────────────────────────────────

  paidTierIt("the payoff renders as a status line while the rows behind unlock live-and-on", async () => {
    const c = controller();
    c.userId = "u";
    c.openPaywall();
    render(App, { props: { controller: c, onGet: () => {} } });
    expect(document.querySelectorAll(".card.locked").length).toBe(3); // still locked pre-payoff
    c.entitled = true; // the entitlement store write landed while the sheet is open
    await tick();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(STRINGS.paywall.unlocked);
    // The service rows behind the sheet are already live: no locks, previously-on services on.
    expect(document.querySelectorAll(".card.locked").length).toBe(0);
    const instagram = document.querySelector(
      '[data-service="instagram"] [role="switch"]',
    );
    expect(instagram?.getAttribute("aria-checked")).toBe("true");
    // Nothing left to buy: the CTA/restore affordances are gone during the payoff.
    expect(screen.queryByText(STRINGS.paywall.restore)).toBeNull();
    c.dismissPaywall(); // clear the payoff auto-dismiss timer
  });

  // ── modal focus containment (the shared trap in focus-trap.ts) ─────────────────────────────────
  // jsdom never blurs a control that becomes disabled, so this exercises the trap's
  // !hasAttribute("disabled") filter directly rather than the real-browser blur behavior. The
  // paywall sheet's own focus cases live in paid-tier-paywall-sheet.test.ts, which mocks the
  // switch on so they keep running while the paid tier is dormant.

  it("the sign-in Tab cycle skips the cooldown-disabled resend control", async () => {
    const c = controller({ auth: codeCapableAuth() });
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    await c.signIn("a@b.com"); // → code entry; resend disabled behind the 60s cooldown
    await tick();
    const dialog = screen.getByRole("dialog");
    const dismiss = within(dialog).getByText(
      STRINGS.auth.cancel,
    ) as HTMLButtonElement;
    dismiss.focus();
    await fireEvent.keyDown(dialog, { key: "Tab" });
    // Wraps to the first ENABLED focusable — the code input — never the disabled verify
    // (code empty) or resend (cooldown) buttons between them.
    expect(document.activeElement).toBe(document.querySelector("input.code"));
    c.dismissSignIn(); // stop the cooldown ticker
  });
});

describe("Placeholder", () => {
  it("renders one calm line and no buttons (no scolding)", () => {
    render(Placeholder, { props: {} });
    expect(screen.getByText(/Nothing here/)).toBeTruthy();
    expect(document.querySelectorAll("button").length).toBe(0);
  });
});

describe("App — purchase-first surfaces (plan 2026-07-15-001)", () => {
  // The two receipt-flavoured card states (`pro-no-account` and `pro-device-only`) exist only to
  // describe what a purchase granted. With every service included they are unreachable, and their
  // cases run with the switch mocked on in paid-tier-sync-card.test.ts rather than going dark.

  includedAccessIt("an earlier purchase changes nothing about the signed-out card", () => {
    // The receipt still resolves and `entitled` is still true, which is what a returning purchaser
    // needs. It simply no longer selects a different card, because there is nothing left to say
    // about a purchase that grants what everybody already has.
    const c = controller({ auth: codeCapableAuth() });
    c.receiptEntitled = true;
    render(App, { props: { controller: c } });
    expect(c.entitled).toBe(true);
    expect(c.popupState).toBe("signed-out");
    expect(screen.queryByText(STRINGS.proNoAccount.active)).toBeNull();
    expect(screen.queryByText(STRINGS.paywall.restoreSignedOut)).toBeNull();
    expect(screen.getByText(STRINGS.sync.signedOut)).toBeTruthy();
    expect(screen.getByText(STRINGS.auth.signInCta)).toBeTruthy();
  });

  paidTierIt("success screen (account-pitch): two independent equal-weight CTAs, no auto-dismiss markup", async () => {
    const c = controller({ auth: codeCapableAuth() });
    c.showPurchaseSuccess();
    render(App, { props: { controller: c } });
    const create = screen.getByText(STRINGS.success.createAccount);
    const notNow = screen.getByText(STRINGS.success.notNow);
    // Two real, separately focusable buttons — never nested inside one wrapping payoff button.
    expect((create as HTMLElement).closest("button")).not.toBe(
      (notNow as HTMLElement).closest("button"),
    );
    expect(screen.getByText(STRINGS.success.reassure)).toBeTruthy();
    await fireEvent.click(notNow);
    expect(c.successScreen).toBe("none");
    expect(c.paywallOpen).toBe(false);
  });

  paidTierIt("success screen (synced): sync confirmation, no account CTA at a signed-in buyer", () => {
    const c = controller({ auth: codeCapableAuth() });
    c.userId = "u1";
    c.showPurchaseSuccess();
    render(App, { props: { controller: c } });
    expect(screen.getByText(STRINGS.success.synced)).toBeTruthy();
    expect(screen.queryByText(STRINGS.success.createAccount)).toBeNull();
  });

  includedAccessIt("a signed-in device with a receipt-only purchase still syncs its settings", () => {
    // The old warning here was that a receipt-only purchase does not buy sync, so the card must
    // not promise it. Sync now follows the account rather than the purchase, so the promise is
    // true for this person and the separate state is gone.
    const c = controller({ auth: codeCapableAuth() });
    c.userId = "u1";
    c.receiptEntitled = true; // server lane false: attach ineligible or webhook not landed
    render(App, { props: { controller: c } });
    expect(c.serverEntitled).toBe(false);
    expect(c.popupState).toBe("entitled-syncing");
    expect(screen.getByText(STRINGS.sync.syncing)).toBeTruthy();
    expect(screen.getByText(STRINGS.auth.signOut)).toBeTruthy();
  });

  paidTierIt("stale-identity paywall state: retry CTA label + calm status line (R15)", () => {
    const c = controller({ auth: codeCapableAuth() });
    c.openPaywall();
    c.purchaseFlow = "stale-identity";
    render(App, { props: { controller: c } });
    expect(screen.getByText(STRINGS.paywall.staleIdentity)).toBeTruthy();
    expect(screen.getByText(STRINGS.paywall.retryPurchase)).toBeTruthy();
  });

  paidTierIt("signed-out paywall: price on the CTA and the no-account reassurance (R1/R12)", () => {
    const c = controller({ auth: codeCapableAuth() });
    c.paywallPrice = "$1.99";
    c.openPaywall();
    render(App, { props: { controller: c } });
    expect(screen.getByText(/Get Still Pro · \$1\.99/)).toBeTruthy();
    expect(screen.getByText(STRINGS.paywall.noAccountNeeded)).toBeTruthy();
    expect(screen.getByText(STRINGS.paywall.restoreSignedOut)).toBeTruthy();
  });
});
