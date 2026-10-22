import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import SignInSheet from "../components/SignInSheet.svelte";
import { STRINGS } from "../strings.js";
import { codeAuth, makeController } from "./support/controller-fixtures.js";
import type { UiAuth } from "../controller.svelte.js";
import type { RequestCodeOutcome, VerifyCodeOutcome } from "../../sync/ports.js";

const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  stops.splice(0).forEach(stop => stop());
});

function mount(auth: UiAuth) {
  const { c } = makeController({ auth });
  stops.push(() => c.dispose());
  const onDismiss = vi.fn();
  const onSkip = vi.fn();
  render(SignInSheet, { controller: c, onDismiss, skip: { label: "Skip", onSkip } });
  return { c, onDismiss, onSkip };
}

function submit(input: HTMLElement) {
  const form = input.closest("form");
  if (!form) throw new Error("Expected a native sign-in form");
  return fireEvent.submit(form);
}

describe("sign-in form submission", () => {
  it("rejects malformed email and incomplete code, and submits each valid value once while busy", async () => {
    let sent!: (outcome: RequestCodeOutcome) => void;
    let verified!: (outcome: VerifyCodeOutcome) => void;
    const auth = codeAuth({
      requestCode: vi.fn(() => new Promise<RequestCodeOutcome>(resolve => { sent = resolve; })),
      verifyCode: vi.fn(() => new Promise<VerifyCodeOutcome>(resolve => { verified = resolve; })),
    });
    mount(auth);
    const email = screen.getByLabelText(STRINGS.auth.emailLabel);
    await fireEvent.input(email, { target: { value: "broken@" } });
    await submit(email);
    expect(auth.requestCode).not.toHaveBeenCalled();
    await fireEvent.input(email, { target: { value: "reader@example.test" } });
    await submit(email);
    await submit(email);
    expect(auth.requestCode).toHaveBeenCalledTimes(1);
    expect(auth.requestCode).toHaveBeenCalledWith("reader@example.test");
    sent({ kind: "sent" });
    const code = await screen.findByLabelText(STRINGS.codeAuth.codeLabel);
    await fireEvent.input(code, { target: { value: "123" } });
    await submit(code);
    expect(auth.verifyCode).not.toHaveBeenCalled();
    await fireEvent.input(code, { target: { value: "123456" } });
    await submit(code);
    await submit(code);
    expect(auth.verifyCode).toHaveBeenCalledTimes(1);
    expect(auth.verifyCode).toHaveBeenCalledWith("reader@example.test", "123456");
    verified({ kind: "invalid-code" });
    await screen.findByText(STRINGS.codeAuth.wrongCode);
  });

  it("keeps resend, change-address, skip and cancel separate from verification", async () => {
    const auth = codeAuth();
    const { c, onDismiss, onSkip } = mount(auth);
    const email = screen.getByLabelText(STRINGS.auth.emailLabel);
    await fireEvent.input(email, { target: { value: "reader@example.test" } });
    await submit(email);
    const code = await screen.findByLabelText(STRINGS.codeAuth.codeLabel);
    await fireEvent.input(code, { target: { value: "123456" } });
    c.rehydrateCodeEntry({ email: "reader@example.test", requestedAt: Date.now() - 120_000 });
    await fireEvent.click(await screen.findByRole("button", { name: STRINGS.codeAuth.resend }));
    expect(auth.requestCode).toHaveBeenCalledTimes(2);
    expect(auth.verifyCode).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: STRINGS.codeAuth.differentEmail }));
    expect(auth.verifyCode).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await fireEvent.click(screen.getByRole("button", { name: STRINGS.auth.cancel }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(auth.requestCode).toHaveBeenCalledTimes(2);
  });

  it("preserves magic-link submission for hosts without code capability", async () => {
    const auth = { signOut: vi.fn(async () => {}), signIn: vi.fn(async () => ({})) };
    mount(auth);
    const email = screen.getByLabelText(STRINGS.auth.emailLabel);
    await fireEvent.input(email, { target: { value: "reader@example.test" } });
    await submit(email);
    await screen.findByText(STRINGS.auth.sent);
    expect(auth.signIn).toHaveBeenCalledWith("reader@example.test");
  });

  it("does not submit again during send or verification rate limits", async () => {
    const auth = codeAuth({
      requestCode: vi.fn(async () => ({ kind: "send-rate-limited" as const })),
      verifyCode: vi.fn(async () => ({ kind: "verify-rate-limited" as const })),
    });
    const { c } = mount(auth);
    const email = screen.getByLabelText(STRINGS.auth.emailLabel);
    await fireEvent.input(email, { target: { value: "reader@example.test" } });
    await submit(email);
    expect(c.sendBlockRemaining).toBeGreaterThan(0);
    await submit(email);
    expect(auth.requestCode).toHaveBeenCalledTimes(1);
    // Advance to an already-sent code without clearing the independent send lock.
    c.codeEmail = "reader@example.test";
    c.authFlow = "code-entry";
    const code = await screen.findByLabelText(STRINGS.codeAuth.codeLabel);
    await fireEvent.input(code, { target: { value: "123456" } });
    await submit(code);
    expect(c.verifyBlockRemaining).toBeGreaterThan(0);
    await submit(code);
    expect(auth.verifyCode).toHaveBeenCalledTimes(1);
  });
});
