<script lang="ts">
  import { onDestroy } from "svelte";
  import type { AppleOnboardingProps } from "./apple-onboarding-presentation.js";
  import SharingCard from "./SharingCard.svelte";
  import Glyph from "./Glyph.svelte";
  import "./design/styles.css";
  import "./apple-onboarding-layout.css";
  let {
    step,
    platform,
    onBack,
    onContinue,
    setup,
    detection,
    onAssertEnabled,
    onDoLater,
    consent,
    onOpenSafari,
    onGoToSettings,
  }: AppleOnboardingProps = $props();
  let macOn = $derived(
    platform === "mac" &&
      detection?.verified === true &&
      detection.state === "on",
  );
  let macWaiting = $derived(
    platform === "mac" &&
      detection?.verified === true &&
      detection.state === "waiting",
  );
  let canChoose = $derived(
    consent.status === "unasked" || consent.status === "failed",
  );
  let mounted = true;
  onDestroy(() => {
    mounted = false;
  });
  function back() {
    if (mounted && step > 1) onBack?.();
  }
  function continueStep() {
    if (
      mounted &&
      (step === 1 ||
        (step === 2 && macOn) ||
        (step === 3 && consent.status === "saved"))
    )
      onContinue?.();
  }
  function openSetup() {
    if (mounted && step === 2 && !macOn) setup?.onOpen?.();
  }
  function assertEnabled() {
    if (mounted && step === 2 && platform === "ios") onAssertEnabled?.();
  }
  function doLater() {
    if (mounted && step === 2 && platform === "mac" && !macOn) onDoLater?.();
  }
  function openSafari() {
    if (mounted && step === 4) onOpenSafari?.();
  }
  function goToSettings() {
    if (mounted && step === 4) onGoToSettings?.();
  }
  function share() {
    if (
      mounted &&
      step === 3 &&
      canChoose &&
      consent.purposesVerified &&
      consent.purposes?.length
    )
      consent.onShare?.();
  }
  function decline() {
    if (mounted && step === 3 && canChoose) consent.onDecline?.();
  }
  function operationAction() {
    if (mounted && step === 3) consent.operation?.onAction?.();
  }
</script>

{#snippet mark()}
  <div
    class="still-logo"
    role="img"
    aria-label="Still"
    translate="no"
    style="--logo-mark-size:64px;"
  >
    <svg class="mark" viewBox="0 0 48 48" aria-hidden="true">
      <rect width="48" height="48" rx="13" fill="var(--still-blue)" />
      <line
        x1="9"
        y1="30"
        x2="39"
        y2="30"
        stroke="#fff"
        stroke-width="2.4"
        stroke-linecap="round"
      />
      <circle cx="24" cy="26.4" r="3.6" fill="#fff" />
    </svg>
  </div>
{/snippet}

<main class="still-ui ob">
  <div class="ob-col">
    <div class="ob-top">
      {#if step > 1}<button
          type="button"
          class="link"
          disabled={!onBack}
          onclick={back}>Back</button
        >{:else}<span></span>{/if}
      <span>Step {step} of 4</span>
    </div>
    <div class="ob-main">
      {#if step === 1}
        {@render mark()}
        <h1>Welcome to Still</h1>
        <p class="lede">
          Still removes Shorts, Reels and the TikTok website when you browse in
          Safari. It doesn't work inside the YouTube, Instagram, Facebook or
          TikTok apps.
        </p>
        <p class="caption">Free. No account needed.</p>
      {:else if step === 2}
        <h1>Turn on Still in Safari</h1>
        <p class="lede">
          Still works inside Safari. Your choices start working once it's on.
        </p>
        {#if setup}<section class="card card-stack">
            <ol class="onboarding-steps">
              {#each setup.steps as instruction, index (index)}<li>
                  {instruction}
                </li>{/each}
            </ol>
          </section>{/if}
        {#if macWaiting || macOn}
          <div
            class="status-line"
            data-tone={macOn ? "success" : "pending"}
            role="status"
          >
            <span class="glyph"
              ><Glyph name={macOn ? "check" : "spinner"} size={16} /></span
            >
            <div class="status-body">
              <span
                >{macOn
                  ? "Still is on in Safari."
                  : "Waiting for Still in Safari…"}</span
              >
            </div>
          </div>
        {/if}
      {:else if step === 3}
        <h1>Help improve Still?</h1>
        {#if consent.status === "saved"}
          <div class="status-line" data-tone="info" role="status">
            <div class="status-body">
              <span>Saved. Change this any time in Settings.</span>
            </div>
          </div>
        {:else}
          <SharingCard
            state="unasked"
            purposes={consent.purposes}
            purposesVerified={consent.purposesVerified}
            onShare={canChoose && consent.onShare ? share : undefined}
            onDecline={canChoose && consent.onDecline ? decline : undefined}
          />
        {/if}
        {#if consent.operation}
          <div
            class="status-line"
            data-tone={consent.operation.tone}
            role={consent.operation.tone === "failed" ? "alert" : "status"}
          >
            <div class="status-body">
              <span>{consent.operation.text}</span
              >{#if consent.operation.detail}<span
                  class="muted"
                  style="font-size:calc(12.5px * var(--text-scale, 1));"
                  >{consent.operation.detail}</span
                >{/if}{#if consent.operation.actionLabel}<button
                  type="button"
                  class="link status-action"
                  disabled={!consent.operation.onAction}
                  onclick={operationAction}
                  >{consent.operation.actionLabel}</button
                >{/if}
            </div>
          </div>
        {/if}
      {:else}
        {@render mark()}
        <h1>You're set</h1>
        <p class="lede">
          Open Safari and visit YouTube, Instagram, Facebook or TikTok. You can
          change anything in Settings.
        </p>
        <p class="caption">
          Settings sync is free and optional. Sign in from Settings any time.
        </p>
      {/if}
    </div>
    {#if step !== 3 || consent.status === "saved"}
      <div class="ob-actions">
        {#if step === 1 || step === 3 || (step === 2 && macOn)}
          <button
            type="button"
            class="primary block"
            disabled={!onContinue}
            onclick={continueStep}>Continue</button
          >
        {:else if step === 2}
          {#if setup}<button
              type="button"
              class="primary block"
              disabled={!setup.onOpen}
              onclick={openSetup}>{setup.actionLabel}</button
            >{/if}
          {#if platform === "mac"}<button
              type="button"
              class="link"
              disabled={!onDoLater}
              onclick={doLater}>Do this later</button
            >{:else}<button
              type="button"
              class="link"
              disabled={!onAssertEnabled}
              onclick={assertEnabled}>I've turned it on</button
            >{/if}
        {:else}
          <button
            type="button"
            class="primary block"
            disabled={!onOpenSafari}
            onclick={openSafari}>Open Safari</button
          >
          <button
            type="button"
            class="link"
            disabled={!onGoToSettings}
            onclick={goToSettings}>Go to Settings</button
          >
        {/if}
      </div>
    {/if}
  </div>
</main>
