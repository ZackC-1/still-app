<script lang="ts">
  import { WORDMARK_DATA_URL } from "../assets/wordmark.js";
  import type { FirstRunProps } from "./first-run-presentation.js";
  import type { OperationStatus } from "./extension-settings-presentation.js";
  import SharingCard from "./SharingCard.svelte";
  import Glyph from "./Glyph.svelte";
  import "./design/styles.css";
  import "./first-run-layout.css";
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
  let pinned = $derived(
    browser === "chrome" && pin !== undefined && pin.verified && pin.pinned,
  );
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
      <img class="word" src={WORDMARK_DATA_URL} alt="" />
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
        {#if pin}<li class="step" data-done={pinned || undefined}>
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
          </li>{/if}
        <li class="step" data-done={signedIn || undefined}>
          <span class="num" aria-hidden="true"
            >{#if signedIn}<Glyph name="check" size={14} />{:else}{pin
                ? 3
                : 2}{/if}</span
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
