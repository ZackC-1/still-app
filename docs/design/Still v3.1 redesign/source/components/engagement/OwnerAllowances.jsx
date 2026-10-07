import React, { useState } from 'react';
import { Toggle } from '../controls/Toggle.jsx';
import { Button } from '../controls/Button.jsx';
import { StatusLine } from '../feedback/StatusLine.jsx';

const SURFACES = [
  { id: 'chrome', name: 'Chrome desktop' },
  { id: 'edge', name: 'Edge desktop', deferred: true },
  { id: 'firefox', name: 'Firefox desktop' },
  { id: 'firefox-android', name: 'Firefox Android' },
  { id: 'apple-mobile', name: 'Apple mobile host' },
  { id: 'apple-mac', name: 'Apple macOS host' },
];
const ST = {
  applying: ['pending', 'Applying…'],
  readback: ['pending', 'Reading back the saved allowances…'],
  applied: ['success', 'Applied and read back. The server matches.'],
  stale: ['caution', 'These changed since you loaded them. Reload to see the current state.', 'Reload'],
  failed: ['failed', "Apply didn't finish. Nothing changed.", 'Try again'],
};
const onOff = v => (v ? 'On' : 'Off');

export function OwnerAllowances({ surfaces = SURFACES, current = {}, draft: draftProp, onDraftChange, state = 'idle', onApply, onDiscard, onStatusAction, announce = true }) {
  const [inner, setInner] = useState(current);
  const draft = draftProp ?? inner;
  const set = (id, v) => { const d = { ...draft, [id]: v }; if (!draftProp) setInner(d); onDraftChange && onDraftChange(d); };
  const changed = ['global', ...surfaces.map(s => s.id)].filter(k => !!draft[k] !== !!current[k]);
  const busy = state === 'applying' || state === 'readback';
  const live = surfaces.filter(s => !s.deferred && draft.global && draft[s.id]).map(s => s.name);
  const st = ST[state];
  const Row = ({ id, name, deferred, inactive }) => (
    <div className="allow-row" data-inactive={inactive || undefined}>
      <div className="row-main">
        <span className="label"><span id={'al-' + id}>{name}</span>{deferred && <span className="access-tag boxed">Deferred</span>}{!deferred && changed.includes(id) && <span className="access-tag boxed">Changed</span>}</span>
      </div>
      {!deferred && <Toggle size="small" checked={!!draft[id]} onChange={v => set(id, v)} disabled={busy} labelledBy={'al-' + id} />}
    </div>
  );
  return (
    <section className="card card-stack" aria-label="Rating prompt allowances">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h2 className="card-title">Rating prompt allowances</h2>
        <p className="card-body" style={{ fontSize: 'calc(13px * var(--text-scale, 1))' }}>Off everywhere until you allow it. Nothing changes until Apply.</p>
      </div>
      <div className="allow-list">
        <Row id="global" name="All surfaces" />
        {surfaces.map(s => <Row key={s.id} id={s.id} name={s.name} deferred={s.deferred} inactive={!draft.global} />)}
      </div>
      <p className="allow-preview">After Apply, prompts are allowed on {live.length ? <strong>{live.join(', ')}</strong> : <strong>no surfaces</strong>}.</p>
      {st && <StatusLine tone={st[0]} actionLabel={st[2]} onAction={onStatusAction} announce={announce}>{st[1]}</StatusLine>}
      <div className="inline-actions">
        <Button inline disabled={!changed.length || busy} onClick={onApply}>Apply</Button>
        {changed.length > 0 && !busy && <Button variant="link" onClick={() => { if (!draftProp) setInner(current); onDiscard && onDiscard(); }}>Discard changes</Button>}
      </div>
    </section>
  );
}
