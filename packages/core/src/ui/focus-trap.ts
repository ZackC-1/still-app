// Shared modal focus containment for the bottom sheets (PaywallSheet / SignInSheet). The keydown
// listener is window-level (capture phase) rather than on the sheet element: when the focused
// control disables itself mid-flow (busy/sending states) the browser blurs focus to document.body,
// and a sheet-scoped handler would go dead — Escape and Tab must keep working for the sheet's
// whole mounted lifetime.

export interface FocusTrapOptions {
  /** The mounted sheet element, read at keypress time (bind:this refs start undefined). */
  container: () => HTMLElement | undefined;
  /** Selector for the sheet's focusable elements; disabled ones are filtered per keypress. */
  focusable: string;
  /** Escape-to-dismiss, wired to the sheet's own dismiss semantics. */
  onDismiss: () => void;
}

/**
 * Trap keyboard focus inside a modal sheet for its mounted lifetime. Call from a `$effect` and
 * return the result: the teardown removes the listener and restores focus to whatever was focused
 * when the sheet opened (skipped when that node has since left the document).
 */
export function trapFocus(options: FocusTrapOptions): () => void {
  const opener = document.activeElement;

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      options.onDismiss();
      return;
    }
    if (e.key !== "Tab") return;
    const container = options.container();
    if (!container) return;
    const focusables = [
      ...container.querySelectorAll<HTMLElement>(options.focusable),
    ].filter((element) => !element.hasAttribute("disabled"));
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    // Focus escaped the sheet (e.g. the focused button disabled itself and blurred to body):
    // pull the cycle back inside instead of letting Tab reach the page behind the modal.
    if (!(active instanceof HTMLElement) || !container.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  window.addEventListener("keydown", onKeydown, true);
  return () => {
    window.removeEventListener("keydown", onKeydown, true);
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  };
}
