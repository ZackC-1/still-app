<script lang="ts">
  let {
    checked,
    onChange,
    label,
    labelledBy,
    describedBy,
    disabled = false,
    small = false,
    onBlue = false,
  }: {
    checked: boolean;
    onChange?: (next: boolean) => void;
    label?: string;
    labelledBy?: string;
    describedBy?: string;
    disabled?: boolean;
    small?: boolean;
    onBlue?: boolean;
  } = $props();
</script>

<button
  type="button"
  class="toggle"
  class:on={checked}
  class:small
  class:on-blue={onBlue}
  role="switch"
  aria-checked={checked}
  aria-label={labelledBy ? undefined : label}
  aria-labelledby={labelledBy}
  aria-describedby={describedBy}
  aria-disabled={disabled || undefined}
  onclick={() => {
    if (!disabled) onChange?.(!checked);
  }}
>
  <span class="knob"></span>
</button>
