<script lang="ts">
  interface Props {
    checked: boolean;
    label: string;
    onchange: () => void;
  }
  let { checked, label, onchange }: Props = $props();
</script>

<button
  type="button"
  class="toggle"
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
    inline-size: 44px;
    block-size: 26px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface-raised);
    padding: 0;
    cursor: pointer;
    transition: background 120ms ease;
    flex: none;
  }
  .toggle.on {
    background: var(--still-blue);
    border-color: var(--still-blue);
  }
  .knob {
    display: block;
    inline-size: 20px;
    block-size: 20px;
    border-radius: 999px;
    background: var(--on-blue);
    transform: translateX(2px);
    transition: transform 120ms ease;
  }
  .toggle.on .knob {
    transform: translateX(20px);
  }
  .toggle:focus-visible {
    outline: 2px solid var(--still-blue);
    outline-offset: 2px;
  }
</style>
