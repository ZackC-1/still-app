// ISS-0123: the sign-in sheet carries why it was opened. Get Still Pro opens the purchase sign-in
// (owner copy ruling P2-19); every other way in opens the settings-sync sign-in. The browsers have
// no "Buy without an account", so the purchase sheet never says sign-in is optional.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import App from "../App.svelte";
import { UiController, type UiAuth } from "../controller.svelte.js";
import type { EmailConsent } from "../email-consent.js";
import { STRINGS } from "../strings.js";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";

const NBH = "‑"; // non-breaking hyphen (ISS-0124)
const OPTIONAL = /Sign-in is optional/;

function auth(): UiAuth {
  return {
    signOut: () => Promise.resolve(),
    requestCode: () => Promise.resolve({ kind: "sent" } as const),
    verifyCode: () => Promise.resolve({ kind: "verified", userId: "u" } as const),
  };
}

function controller(emailConsent: EmailConsent) {
  const initial = { ...DEFAULT_SETTINGS, updatedAt: 1 };
  const cache = new SettingsCache(new InMemoryStorageAdapter(initial), {
    initial,
    now: () => Date.now(),
  });
  return new UiController({ cache, host: { canPurchase: false, emailConsent }, auth: auth() });
}

async function open(c: UiController, purpose?: "purchase" | "sync") {
  render(App, { props: { controller: c } });
  if (purpose) c.openSignIn(purpose);
  else c.openSignIn();
  await tick();
  return screen.getByRole("dialog");
}

describe("purchase sign-in copy (owner ruling P2-19)", () => {
  it("states the exact owner wording", () => {
    expect(STRINGS.purchaseAuth).toEqual({
      title: "Sign in to get Still Pro",
      prompt: `Enter your email to get a 6${NBH}digit sign-in code.`,
      note: "Sign in first to keep Still Pro with your account.",
    });
  });

  it("Chrome: the disclosure fits a purchase, then the email step is the purchase sign-in", async () => {
    const c = controller("disclosure");
    const sheet = await open(c, "purchase");
    expect(within(sheet).getByRole("heading", { name: STRINGS.emailConsent.disclosureTitle })).toBeTruthy();
    expect(within(sheet).getByText(STRINGS.emailConsent.purchaseBody)).toBeTruthy();
    expect(within(sheet).queryByText(STRINGS.emailConsent.body)).toBeNull();
    await fireEvent.click(within(sheet).getByRole("button", { name: STRINGS.emailConsent.proceed }));
    await tick();
    expect(within(sheet).getByRole("heading", { name: "Sign in to get Still Pro" })).toBeTruthy();
    expect(within(sheet).getByText(STRINGS.purchaseAuth.prompt)).toBeTruthy();
    expect(within(sheet).getByText("Sign in first to keep Still Pro with your account.")).toBeTruthy();
    expect(within(sheet).queryByText(OPTIONAL)).toBeNull();
    expect(within(sheet).queryByText(STRINGS.auth.title)).toBeNull();
    // No way to buy without an account on a browser.
    expect(within(sheet).queryByRole("button", { name: "Buy without an account" })).toBeNull();
  });

  it("Firefox: the opt-in asks about Still Pro, then the email step is the purchase sign-in", async () => {
    const c = controller("opt-in");
    const sheet = await open(c, "purchase");
    expect(within(sheet).getByRole("heading", { name: STRINGS.emailConsent.purchaseOptInTitle })).toBeTruthy();
    expect(within(sheet).queryByText(STRINGS.emailConsent.optInTitle)).toBeNull();
    expect(within(sheet).getByText(STRINGS.emailConsent.purchaseBody)).toBeTruthy();
    expect(within(sheet).getByText(STRINGS.emailConsent.purchaseAgree)).toBeTruthy();
    await fireEvent.click(within(sheet).getByRole("checkbox"));
    await fireEvent.click(within(sheet).getByRole("button", { name: STRINGS.emailConsent.proceed }));
    await tick();
    expect(within(sheet).getByRole("heading", { name: "Sign in to get Still Pro" })).toBeTruthy();
    expect(within(sheet).getByText(STRINGS.purchaseAuth.note)).toBeTruthy();
    expect(within(sheet).queryByText(OPTIONAL)).toBeNull();
  });

  it("the code step keeps the purchase heading and shows the code field only (D5)", async () => {
    const c = controller("none");
    const sheet = await open(c, "purchase");
    await fireEvent.input(within(sheet).getByLabelText(STRINGS.auth.emailLabel), {
      target: { value: "fixture@still.test" },
    });
    await fireEvent.click(within(sheet).getByRole("button", { name: STRINGS.codeAuth.send }));
    expect(await within(sheet).findByLabelText(STRINGS.codeAuth.codeLabel)).toBeTruthy();
    expect(within(sheet).getByRole("heading", { name: STRINGS.purchaseAuth.title })).toBeTruthy();
    expect(within(sheet).queryByText(STRINGS.purchaseAuth.note)).toBeNull();
    expect(within(sheet).queryByText(OPTIONAL)).toBeNull();
  });
});

describe("settings-sync sign-in keeps its own copy", () => {
  it.each(["disclosure", "opt-in", "none"] as const)("%s: the sync sheet is unchanged", async (consent) => {
    const c = controller(consent);
    const sheet = await open(c);
    if (consent !== "none") {
      expect(within(sheet).getByText(STRINGS.emailConsent.body)).toBeTruthy();
      if (consent === "opt-in") {
        expect(within(sheet).getByRole("heading", { name: STRINGS.emailConsent.optInTitle })).toBeTruthy();
        expect(within(sheet).getByText(STRINGS.emailConsent.agree)).toBeTruthy();
        await fireEvent.click(within(sheet).getByRole("checkbox"));
      }
      await fireEvent.click(within(sheet).getByRole("button", { name: STRINGS.emailConsent.proceed }));
      await tick();
    }
    expect(within(sheet).getByRole("heading", { name: "Sign in for settings sync" })).toBeTruthy();
    expect(within(sheet).getByText(STRINGS.auth.prompt)).toBeTruthy();
    expect(within(sheet).queryByText(STRINGS.purchaseAuth.note)).toBeNull();
  });

  it("a purchase sheet that was closed does not colour the next sync sign-in", async () => {
    const c = controller("none");
    await open(c, "purchase");
    c.dismissSignIn();
    await tick();
    c.openSignIn();
    await tick();
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByRole("heading", { name: STRINGS.auth.title })).toBeTruthy();
    expect(within(sheet).queryByText(STRINGS.purchaseAuth.note)).toBeNull();
  });

  it("a code entry restored after the page closed keeps a purchase purpose", async () => {
    const c = controller("none");
    render(App, { props: { controller: c } });
    c.rehydrateCodeEntry({ email: "fixture@still.test", requestedAt: Date.now(), purchaseIntent: true });
    await tick();
    expect(screen.getByRole("heading", { name: STRINGS.purchaseAuth.title })).toBeTruthy();
    c.dismissSignIn();
    c.rehydrateCodeEntry({ email: "fixture@still.test", requestedAt: Date.now() });
    await tick();
    expect(screen.getByRole("heading", { name: STRINGS.auth.title })).toBeTruthy();
  });
});
