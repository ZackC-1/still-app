import React from 'react';
import { useModalFocus } from './useModalFocus.js';

export function Dialog({ open = true, title, body, confirmLabel, onConfirm, cancelLabel = 'Cancel', onCancel, tone = 'default', contained = false, trapFocus = true, children }) {
  const ref = useModalFocus(open && trapFocus, onCancel);
  if (!open) return null;
  const pos = contained ? { position: 'absolute' } : undefined;
  const id = 'dlg-' + (title || 'x').replace(/\W+/g, '-').toLowerCase();
  return (
    <>
      <div className="scrim" style={pos} onClick={onCancel}></div>
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={id + '-t'} aria-describedby={body ? id + '-b' : undefined} style={pos}>
        <h2 id={id + '-t'}>{title}</h2>
        {body && <p className="body" id={id + '-b'}>{body}</p>}
        {children}
        <div className="dialog-actions">
          {confirmLabel && <button type="button" className={tone === 'danger' ? 'danger-solid' : 'primary'} onClick={onConfirm}>{confirmLabel}</button>}
          <button type="button" className="secondary" data-autofocus="" onClick={onCancel}>{cancelLabel}</button>
        </div>
      </div>
    </>
  );
}
