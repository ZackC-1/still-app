import React from 'react';
import { Toggle } from '../controls/Toggle.jsx';
import { StatusLine } from '../feedback/StatusLine.jsx';

const W = {
  requested: ['pending', "Deletion requested. Your shared data hasn't been deleted yet."],
  verifying: ['pending', 'Confirming deletion with our providers…'],
  deleted: ['success', 'Your shared data has been deleted.'],
  failed: ['failed', "We couldn't send your deletion request. Sharing stays off on this device.", 'Try again'],
};

export function SharingSetting({ checked = false, onChange, withdrawal = 'none', onRequestDeletion, onRetry, title = 'Share email and usage data', sub = 'Still never tracks or monitors the website you visit', announce = true }) {
  const w = W[withdrawal];
  return (
    <section className="card card-stack">
      <div className="sync-row">
        <div className="sync-row-text"><span className="row-title" id="share-t" style={{ fontSize: 'calc(15px * var(--text-scale, 1))', fontWeight: 600 }}>{title}</span><span className="muted sync-row-sub" id="share-s">{sub}</span></div>
        <Toggle checked={checked} onChange={onChange} labelledBy="share-t" describedBy="share-s" />
      </div>
      {!checked && withdrawal === 'none' && onRequestDeletion && <button type="button" className="link" style={{ fontSize: 'calc(13px * var(--text-scale, 1))' }} onClick={onRequestDeletion}>Delete data you already shared</button>}
      {w && <StatusLine tone={w[0]} actionLabel={w[2]} onAction={onRetry} announce={announce}>{w[1]}</StatusLine>}
    </section>
  );
}
