import React from 'react';
import { Toggle } from '../controls/Toggle.jsx';
import { Glyph } from '../controls/Glyph.jsx';
import { AccessTag } from '../access/AccessTag.jsx';

const HOST = { browser: 'this browser', safari: 'Safari', apple: 'this app' };

export function SwitchRow({ id, label, sub, checked = false, onChange, access = 'free', inactive = false, inactiveNote, host = 'browser', unavailableNote, onAccessAction }) {
  const key = (id || label).replace(/\W+/g, '-');
  const usable = access === 'free' || access === 'protected' || access === 'purchased';
  let note = sub, action = null, tag = null, control = null;
  const srNote = access === 'checking' ? 'Checking your Still Pro access. Your choice is saved.' : access === 'verify' ? 'Verify Still Pro to use this. Your choice is saved.' : null;
  if (access === 'unsupported') note = unavailableNote ?? 'Not available in ' + HOST[host] + '. Your choice is saved.';

  if (usable && inactive) note = inactiveNote ?? sub;
  if (usable || access === 'checking' || access === 'verify') {
    control = <Toggle size="small" checked={checked} onChange={onChange} disabled={inactive || !usable} labelledBy={key + '-l'} describedBy={note || srNote ? key + '-s' : undefined} />;
  } else if (access === 'locked') {
    const aria = label + '. Included in Still Pro. ' + (host === 'safari' ? 'Open the Still app' : 'See Still Pro');
    control = <button type="button" className="lock-pro" aria-label={aria} onClick={onAccessAction}><Glyph name="lock" size={14} /><span>Still Pro</span></button>;
  }
  return (
    <div className="option-row" data-access={access} data-inactive={inactive || access === 'unsupported' || access === 'locked' || undefined}>
      <div className="row-main">
        <span className="label"><span id={key + '-l'}>{label}</span>{tag}</span>
        {note && <span className="sub" id={key + '-s'}>{note}</span>}
        {!note && srNote && <span className="sr-only" id={key + '-s'}>{srNote}</span>}
        {action && <button type="button" className="link row-action" onClick={onAccessAction}>{action}</button>}
      </div>
      {control}
    </div>
  );
}
