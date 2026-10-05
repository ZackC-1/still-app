<script lang="ts">
  import type { FirstRunProps } from "./first-run-presentation.js";
  import type { OperationStatus } from "./extension-settings-presentation.js";
  import SharingCard from "./SharingCard.svelte";
  import Glyph from "./Glyph.svelte";
  import "./design/styles.css";
  import "./first-run-layout.css";
  const wordmarkSrc =
    "data:image/png;base64,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";
  let {
    browser,
    permission,
    blocking,
    setupDescription,
    pin,
    sync,
    consent,
    privacyActions,
    settings,
    privacy,
  }: FirstRunProps = $props();
  let browserName = $derived(browser === "chrome" ? "Chrome" : "Firefox");
  let allowed = $derived(permission.verified && permission.state === "granted");
  let ready = $derived(allowed && blocking.verified && blocking.state === "on");
  let pinned = $derived(browser === "chrome" && pin.verified && pin.pinned);
  let signedIn = $derived(
    sync.account?.confirmed && Boolean(sync.account.address.trim()),
  );
  let canRequest = $derived(
    permission.verified &&
      permission.requestVerified &&
      (permission.state === "needed" || permission.state === "denied") &&
      Boolean(permission.onRequest),
  );
  let canChoose = $derived(
    consent?.status === "unasked" || consent?.status === "failed",
  );
  function requestPermission() {
    if (
      permission.verified &&
      permission.requestVerified &&
      (permission.state === "needed" || permission.state === "denied")
    )
      permission.onRequest?.();
  }
  function share() {
    if (
      consent &&
      (consent.status === "unasked" || consent.status === "failed") &&
      consent.purposesVerified &&
      consent.purposes?.length
    )
      consent.onShare?.();
  }
  function decline() {
    if (consent?.status === "unasked" || consent?.status === "failed")
      consent.onDecline?.();
  }
</script>

{#snippet status(operation: OperationStatus)}
  <div
    class="status-line"
    data-tone={operation.tone}
    role={operation.tone === "failed" ? "alert" : "status"}
  >
    {#if operation.tone !== "info"}<span class="glyph"
        ><Glyph
          name={operation.tone === "pending"
            ? "spinner"
            : operation.tone === "success"
              ? "check"
              : operation.tone === "failed"
                ? "alert"
                : "clock"}
          size={16}
        /></span
      >{/if}
    <div class="status-body">
      <span>{operation.text}</span>{#if operation.detail}<span
          class="muted"
          style="font-size:calc(12.5px * var(--text-scale, 1));"
          >{operation.detail}</span
        >{/if}
    </div>
  </div>
{/snippet}

<main class="still-ui fr">
  <div class="fr-col">
    <div class="still-logo" role="img" aria-label="Still" translate="no">
      <svg class="mark" viewBox="0 0 48 48" aria-hidden="true"
        ><rect width="48" height="48" rx="13" fill="var(--still-blue)" /><line
          x1="9"
          y1="30"
          x2="39"
          y2="30"
          stroke="#fff"
          stroke-width="2.4"
          stroke-linecap="round"
        /><circle cx="24" cy="26.4" r="3.6" fill="#fff" /></svg
      >
      <img class="word" src={wordmarkSrc} alt="" />
    </div>
    <h1>{ready ? "Still is on." : "One step to finish setup."}</h1>
    {#if ready}<p class="lede">
        Visit YouTube, Instagram, Facebook or TikTok as usual.
      </p>{:else if setupDescription?.verified}<p class="lede">
        {setupDescription.text}
      </p>{/if}
    <section class="card">
      <ol class="steps">
        <li class="step" data-done={allowed || undefined}>
          <span class="num" aria-hidden="true"
            >{#if allowed}<Glyph name="check" size={14} />{:else}1{/if}</span
          >
          <span class="t"
            >Allow Still on supported sites{#if allowed}<span class="sr-only"
                >Done.</span
              >{/if}</span
          >
          {#if allowed}<span class="b"
              >Allowed on YouTube, Instagram, Facebook and TikTok.</span
            >{:else if permission.guidance?.verified}<span class="b"
              >{permission.guidance.text}</span
            >{/if}
          {#if permission.verified && permission.state === "needed"}<div
              class="a"
            >
              <button
                type="button"
                class="primary"
                disabled={!canRequest}
                onclick={requestPermission}>Allow</button
              >
            </div>
          {:else if permission.verified && permission.state === "pending"}<div
              class="a"
            >
              {@render status({
                tone: "pending",
                text: `Waiting for ${browserName}…`,
              })}
            </div>
          {:else if permission.verified && permission.state === "denied"}<div
              class="a"
            >
              {@render status({
                tone: "caution",
                text: `${browserName} didn't allow it. Still can't block yet.`,
                detail:
                  "Your choices are saved and start working once it's allowed.",
              })}<button
                type="button"
                class="primary"
                disabled={!canRequest}
                onclick={requestPermission}>Try again</button
              >
            </div>
          {:else if permission.verified && permission.operation}<div class="a">
              {@render status(permission.operation)}
            </div>{/if}
        </li>
        <li class="step" data-done={pinned || undefined}>
          <span class="num" aria-hidden="true"
            >{#if pinned}<Glyph name="check" size={14} />{:else}2{/if}</span
          >
          <span class="t"
            >Pin Still to your toolbar{#if pinned}<span class="sr-only"
                >Done.</span
              >{/if}</span
          >
          {#if pinned}<span class="b">Still is pinned.</span
            >{:else if pin.guidance?.verified}<span class="b"
              >{pin.guidance.text}</span
            >{/if}
        </li>
        <li class="step" data-done={signedIn || undefined}>
          <span class="num" aria-hidden="true"
            >{#if signedIn}<Glyph name="check" size={14} />{:else}3{/if}</span
          >
          <span class="t"
            >Settings sync<span class="access-tag boxed">Optional</span
            >{#if signedIn}<span class="sr-only">Done.</span>{/if}</span
          >
          <span class="b"
            >{signedIn
              ? `Signed in as ${sync.account!.address}.`
              : "Free. Keep your settings updated across every supported surface."}</span
          >
          {#if !signedIn}<div class="a">
              <button
                type="button"
                class="secondary"
                disabled={!sync.onSignIn}
                onclick={() => {
                  if (!(sync.account?.confirmed && sync.account.address.trim()))
                    sync.onSignIn?.();
                }}>Sign in</button
              >
            </div>{/if}
        </li>
      </ol>
    </section>
    {#if consent}
      {#if consent.status === "saved"}
        <section class="card card-stack">
          {@render status({
            tone: "info",
            text:
              consent.choice === "on"
                ? "You chose to share your email and usage data."
                : "You chose not to share your email and usage data.",
            detail: "Change this any time in Still settings.",
          })}
        </section>
      {:else}
        <SharingCard
          state="unasked"
          purposes={consent.purposes}
          purposesVerified={consent.purposesVerified}
          onShare={canChoose && consent.onShare ? share : undefined}
          onDecline={canChoose && consent.onDecline ? decline : undefined}
        />
      {/if}
      {#if consent.operation}<section class="card card-stack">
          {@render status(consent.operation)}
        </section>{/if}
    {:else if privacyActions}
      {@render privacyActions()}
    {/if}
    <footer class="fr-foot">
      <button
        type="button"
        class="link"
        disabled={!settings.verified || !settings.onOpen}
        onclick={() => {
          if (settings.verified) settings.onOpen?.();
        }}>Open Still settings</button
      >
      <button
        type="button"
        class="link"
        disabled={!privacy.verified || !privacy.onOpen}
        onclick={() => {
          if (privacy.verified) privacy.onOpen?.();
        }}>Privacy policy</button
      >
    </footer>
  </div>
</main>
