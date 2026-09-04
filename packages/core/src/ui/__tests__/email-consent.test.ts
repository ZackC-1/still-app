// The step a browser add-on store requires before Still may collect an email address.
//
// The property being pinned is narrow and testable: on a surface that declares a rule, there is no
// email field on screen until the rule is satisfied. Not a hidden field, not a disabled one. If it
// does not exist, nothing can be typed into it, pasted into it, or sent from it, which is what
// "before the email is collected" has to mean to be worth anything.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import App from "../App.svelte";
import { UiController, type UiAuth } from "../controller.svelte.js";
import type { EmailConsent } from "../email-consent.js";
import { STRINGS } from "../strings.js";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";

function codeCapableAuth(over: Partial<UiAuth> = {}): UiAuth {
  return {
    signOut: () => Promise.resolve(),
    requestCode: () => Promise.resolve({ kind: "sent" } as const),
    verifyCode: () => Promise.resolve({ kind: "verified", userId: "u" } as const),
    ...over,
  };
}

function controller(emailConsent: EmailConsent, auth: UiAuth = codeCapableAuth()) {
  const initial = { ...DEFAULT_SETTINGS, updatedAt: 1 };
  const cache = new SettingsCache(new InMemoryStorageAdapter(initial), {
    initial,
    now: () => Date.now(),
  });
  return new UiController({ cache, host: { canPurchase: false, emailConsent }, auth });
}

const emailField = () => document.querySelector("input.email");

describe("the email-consent step", () => {
  it("Chrome: no email field exists until the disclosure is acknowledged", async () => {
    const c = controller("disclosure");
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));

    expect(screen.getByText(STRINGS.emailConsent.disclosureTitle)).toBeTruthy();
    expect(screen.getByText(STRINGS.emailConsent.body)).toBeTruthy();
    expect(emailField()).toBeNull();

    await fireEvent.click(screen.getByText(STRINGS.emailConsent.proceed));
    await tick();
    expect(emailField()).toBeTruthy();
  });

  it("Chrome asks nobody to tick anything: acknowledgement is enough", async () => {
    const c = controller("disclosure");
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    expect(document.querySelector("input[type=checkbox]")).toBeNull();
    const proceed = screen.getByText(STRINGS.emailConsent.proceed) as HTMLButtonElement;
    expect(proceed.disabled).toBe(false);
  });

  it("Firefox: the way forward is locked until the person says yes", async () => {
    const c = controller("opt-in");
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));

    expect(screen.getByText(STRINGS.emailConsent.optInTitle)).toBeTruthy();
    expect(emailField()).toBeNull();
    const proceed = screen.getByText(STRINGS.emailConsent.proceed) as HTMLButtonElement;
    expect(proceed.disabled).toBe(true);

    const agree = document.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(screen.getByText(STRINGS.emailConsent.agree)).toBeTruthy();
    await fireEvent.click(agree);
    await tick();
    expect((screen.getByText(STRINGS.emailConsent.proceed) as HTMLButtonElement).disabled).toBe(false);

    await fireEvent.click(screen.getByText(STRINGS.emailConsent.proceed));
    await tick();
    expect(emailField()).toBeTruthy();
  });

  it("Firefox offers a plain way out that collects nothing", async () => {
    const c = controller("opt-in");
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    await fireEvent.click(screen.getByText(STRINGS.emailConsent.notNow));
    await tick();
    expect(c.signInOpen).toBe(false);
    expect(emailField()).toBeNull();
  });

  it("leaving the flow and starting again asks again", async () => {
    const c = controller("opt-in");
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    await fireEvent.click(document.querySelector("input[type=checkbox]")!);
    await fireEvent.click(screen.getByText(STRINGS.emailConsent.proceed));
    await tick();
    expect(emailField()).toBeTruthy();

    c.dismissSignIn();
    await tick();
    c.openSignIn();
    await tick();
    expect(emailField()).toBeNull();
    expect(screen.getByText(STRINGS.emailConsent.optInTitle)).toBeTruthy();
  });

  it("no request can be issued from the consent step, even by a programmatic caller", async () => {
    // Asserting that nothing fired on its own would pass against an implementation with no guard
    // at all, because nothing on the consent step fires anything. So this calls the send action
    // directly, which is the only way a caller could get past a screen with no email field.
    const requestCode = vi.fn(() => Promise.resolve({ kind: "sent" } as const));
    const c = controller("opt-in", codeCapableAuth({ requestCode }));
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    expect(c.needsEmailConsent).toBe(true);
    expect(emailField()).toBeNull();

    await c.signIn("someone@example.com");
    expect(requestCode).not.toHaveBeenCalled();
    expect(c.authFlow).toBe("idle");

    // The same call goes through the moment the surface's own requirement is met, so the guard is
    // shown to be the reason for the refusal rather than something else in the way.
    c.acceptEmailConsent();
    await c.signIn("someone@example.com");
    expect(requestCode).toHaveBeenCalledWith("someone@example.com");
    c.dismissSignIn(); // stop the resend cooldown ticker
  });

  it("a rehydrated code entry does not ask again: an address was already given, with consent", async () => {
    const c = controller("opt-in");
    c.rehydrateCodeEntry({ email: "a@b.com", requestedAt: Date.now() });
    render(App, { props: { controller: c } });
    expect(c.needsEmailConsent).toBe(false);
    expect(document.querySelector("input.code")).toBeTruthy();
    c.dismissSignIn(); // stop the resend cooldown ticker
  });

  it("the Apple apps show no consent step at all", async () => {
    const c = controller("none");
    render(App, { props: { controller: c } });
    await fireEvent.click(screen.getByText(STRINGS.auth.signInCta));
    expect(screen.queryByText(STRINGS.emailConsent.disclosureTitle)).toBeNull();
    expect(screen.queryByText(STRINGS.emailConsent.optInTitle)).toBeNull();
    expect(emailField()).toBeTruthy();
  });

  it("a host that declares nothing behaves as the Apple apps do", () => {
    const initial = { ...DEFAULT_SETTINGS, updatedAt: 1 };
    const cache = new SettingsCache(new InMemoryStorageAdapter(initial), {
      initial,
      now: () => Date.now(),
    });
    const c = new UiController({ cache, host: { canPurchase: false }, auth: codeCapableAuth() });
    expect(c.emailConsent).toBe("none");
    expect(c.needsEmailConsent).toBe(false);
  });
});
