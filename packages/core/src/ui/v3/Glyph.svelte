<script lang="ts">
  let {
    name,
    size = 16,
    className,
  }: {
    name:
      "lock" | "chevron" | "check" | "alert" | "clock" | "spinner" | "close";
    size?: number;
    className?: string;
  } = $props();
</script>

<svg
  class={className}
  viewBox="0 0 20 20"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === "lock"}<rect x="3" y="9" width="14" height="10" rx="3"
    ></rect><path d="M6 9V6a4 4 0 0 1 8 0v3"></path>
  {:else if name === "chevron"}<path d="M5 8l5 5 5-5"></path>
  {:else if name === "check"}<path d="M4.5 10.5l3.5 3.5 7.5-8"></path>
  {:else if name === "alert"}<circle cx="10" cy="10" r="7.5"></circle><path
      d="M10 6v4.5"
    ></path><path d="M10 13.6v.1"></path>
  {:else if name === "clock"}<circle cx="10" cy="10" r="7.5"></circle><path
      d="M10 6v4l2.5 2"
    ></path>
  {:else if name === "close"}<path d="M5.5 5.5l9 9"></path><path
      d="M14.5 5.5l-9 9"
    ></path>
  {:else}<path d="M10 2.5a7.5 7.5 0 1 1-7.5 7.5"></path>{/if}
</svg>
