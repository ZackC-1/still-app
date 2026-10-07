import React from 'react';
import { Glyph } from '../controls/Glyph.jsx';

const G = { pending: 'spinner', success: 'check', failed: 'alert', caution: 'clock', info: null };

export function StatusLine({ tone = 'info', children, detail, actionLabel, onAction, announce = true }) {
  const role = !announce ? undefined : tone === 'failed' ? 'alert' : 'status';
  return (
    <div className="status-line" data-tone={tone} role={role}>
      {G[tone] && <span className="glyph"><Glyph name={G[tone]} size={16} /></span>}
      <div className="status-body">
        <span>{children}</span>
        {detail && <span className="muted" style={{ fontSize: 'calc(12.5px * var(--text-scale, 1))' }}>{detail}</span>}
        {actionLabel && <button type="button" className="link status-action" onClick={onAction}>{actionLabel}</button>}
      </div>
    </div>
  );
}
