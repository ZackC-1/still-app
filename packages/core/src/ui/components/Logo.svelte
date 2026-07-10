<script lang="ts">
  import {
    WORDMARK_DATA_URL,
    WORDMARK_HEIGHT,
    WORDMARK_WIDTH,
  } from "../assets/wordmark.js";

  // The Still brand lockup: the balance mark (a ball resting still on a line — the app icon) + the
  // stylized "st·ll" wordmark. The wordmark is base64-inlined so it ships in every host bundle.
  interface Props {
    size?: number;
  }
  let { size = 28 }: Props = $props();
</script>

<div class="logo" role="img" aria-label="Still" translate="no">
  <svg
    class="mark"
    viewBox="0 0 48 48"
    width={size}
    height={size}
    aria-hidden="true"
  >
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
  <img
    class="word"
    src={WORDMARK_DATA_URL}
    width={WORDMARK_WIDTH}
    height={WORDMARK_HEIGHT}
    alt=""
  />
</div>

<style>
  .logo {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .mark {
    inline-size: var(--logo-mark-size, 28px);
    block-size: var(--logo-mark-size, 28px);
  }
  .word {
    block-size: var(--logo-word-size, 22px);
    inline-size: auto;
    display: block;
  }
  @media (prefers-color-scheme: dark) {
    .word {
      filter: grayscale(1) brightness(0) invert(1);
    }
  }
</style>
