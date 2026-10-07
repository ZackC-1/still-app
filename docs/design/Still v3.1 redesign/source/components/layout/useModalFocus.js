import { useEffect, useRef } from 'react';

const SEL = 'button:not([disabled]),a[href],input:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Moves focus into a modal, traps Tab, closes on Escape, returns focus to the opener on close.
export function useModalFocus(active, onDismiss) {
  const ref = useRef(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!active) return undefined;
    const opener = document.activeElement;
    const node = ref.current;
    const first = node && (node.querySelector('[data-autofocus]') || node.querySelector(SEL));
    if (first) first.focus({ preventScroll: true });
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); if (dismiss.current) dismiss.current(); return; }
      if (e.key !== 'Tab' || !node) return;
      const els = Array.from(node.querySelectorAll(SEL));
      if (!els.length) return;
      const a = els[0], z = els[els.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); if (opener && opener.focus) opener.focus({ preventScroll: true }); };
  }, [active]);
  return ref;
}
