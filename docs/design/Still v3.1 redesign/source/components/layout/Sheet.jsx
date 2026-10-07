import React from 'react';
import { useModalFocus } from './useModalFocus.js';

export function Sheet({ open = true, title, body, onDismiss, dismissLabel = 'Cancel', contained = false, trapFocus = true, children }) {
  const ref = useModalFocus(open && trapFocus, onDismiss);
  if (!open) return null;
  const pos = contained ? { position: 'absolute' } : undefined;
  return (
    <>
      <div className="scrim" style={pos} onClick={onDismiss}></div>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={title} style={pos}>
        <div className="grip" aria-hidden="true"></div>
        {title && <h2>{title}</h2>}
        {body && <p className="body">{body}</p>}
        {children}
        <button type="button" className="dismiss" onClick={onDismiss}>{dismissLabel}</button>
      </div>
    </>
  );
}
