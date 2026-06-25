<script lang="ts">
  interface Props {
    checked: boolean;
    label: string;
    onchange: () => void;
    /** "on-blue" inverts the colors for use on the blue hero card (white track, blue knob). */
    variant?: "default" | "on-blue";
  }
  let { checked, label, onchange, variant = "default" }: Props = $props();
</script>

<button
  type="button"
  class="toggle {variant}"
  class:on={checked}
  role="switch"
  aria-checked={checked}
  aria-label={label}
  onclick={onchange}
>
  <span class="knob" aria-hidden="true"></span>
</button>

<style>
  .toggle {
    inline-size: 52px;
    block-size: 31px;
    border-radius: 999px;
    border: none;
    background: var(--toggle-off, #d4d8e6);
    padding: 0;
    cursor: pointer;
    transition: background 160ms ease;
    flex: none;
  }
  .toggle.on {
    background: var(--still-blue);
  }
  .knob {
    display: block;
    inline-size: 25px;
    block-size: 25px;
    border-radius: 999px;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
    transform: translateX(3px);
    transition: transform 160ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .toggle.on .knob {
    transform: translateX(24px);
  }

  /* On the blue hero card: white track, blue knob. */
  .toggle.on-blue {
    background: rgba(255, 255, 255, 0.35);
  }
  .toggle.on-blue.on {
    background: #fff;
  }
  .toggle.on-blue .knob {
    background: var(--still-blue);
    box-shadow: none;
  }

  .toggle:focus-visible {
    outline: 2px solid var(--still-blue);
    outline-offset: 3px;
  }
  .toggle.on-blue:focus-visible {
    outline-color: #fff;
  }
</style>
