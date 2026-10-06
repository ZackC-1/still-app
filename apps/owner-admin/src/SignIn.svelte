<script lang="ts">
  // Email-code sign-in, in Still's shipped wording. It says nothing about who may use the page:
  // the server decides that after sign-in, and a refusal looks like "Not available here".
  import { APPROVED } from "./copy.js";
  import type { OwnerAuth } from "./auth.js";

  let { auth, onSignedIn }: { auth: OwnerAuth; onSignedIn: () => void } = $props();

  const copy = APPROVED.signIn;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  let step = $state<"email" | "code">("email");
  let email = $state("");
  let code = $state("");
  let pending = $state(false);
  let message = $state<string | null>(null);

  async function sendCode(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    const address = email.trim();
    if (!EMAIL.test(address)) {
      message = copy.invalidEmail;
      return;
    }
    pending = true;
    message = null;
    const outcome = await auth.requestCode(address);
    pending = false;
    if (outcome === "sent") {
      email = address;
      code = "";
      step = "code";
    } else {
      message = copy.sendError;
    }
  }

  async function verify(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    pending = true;
    message = null;
    const outcome = await auth.verifyCode(email, code.trim());
    pending = false;
    if (outcome === "verified") onSignedIn();
    else message = outcome === "wrong-code" ? copy.wrongCode : copy.verifyError;
  }
</script>

<section class="card card-stack sign-in">
  {#if step === "email"}
    <form class="form" onsubmit={sendCode} novalidate>
      <p class="card-body">{copy.prompt}</p>
      <label class="field-label" for="owner-email">{copy.emailLabel}</label>
      <input
        id="owner-email"
        class="field"
        type="email"
        inputmode="email"
        autocomplete="email"
        placeholder={copy.emailPlaceholder}
        bind:value={email}
        disabled={pending}
      />
      {#if message}<p class="error" role="alert">{message}</p>{/if}
      <button type="submit" class="primary" disabled={pending} aria-busy={pending || undefined}
        >{pending ? copy.sending : copy.send}</button
      >
    </form>
  {:else}
    <form class="form" onsubmit={verify} novalidate>
      <p class="card-body">{copy.sentTo} <strong>{email}</strong></p>
      <label class="field-label" for="owner-code">{copy.codeLabel}</label>
      <input
        id="owner-code"
        class="field code"
        type="text"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="10"
        bind:value={code}
        disabled={pending}
      />
      {#if message}<p class="error" role="alert">{message}</p>{/if}
      <button type="submit" class="primary" disabled={pending || code.trim().length === 0} aria-busy={pending || undefined}
        >{pending ? copy.verifying : copy.verify}</button
      >
      <button
        type="button"
        class="link"
        disabled={pending}
        onclick={() => {
          step = "email";
          message = null;
        }}>{copy.differentEmail}</button
      >
    </form>
  {/if}
</section>

<style>
  .form { display: flex; flex-direction: column; gap: var(--space-3); }
</style>
