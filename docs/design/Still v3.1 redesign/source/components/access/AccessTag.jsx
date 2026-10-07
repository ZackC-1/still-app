import React from 'react';
import { Glyph } from '../controls/Glyph.jsx';

const LABEL = { protected: 'Yours to keep', purchased: 'Still Pro', checking: 'Checking access', verify: 'Needs verification', locked: 'Included in Still Pro', unsupported: 'Not available here' };
const GLYPH = { locked: 'lock', checking: 'clock', verify: 'alert' };

export function AccessTag({ state, label, boxed = false }) {
  if (!state || state === 'free') return null;
  const g = GLYPH[state];
  return <span className={boxed ? 'access-tag boxed' : 'access-tag'}>{g && <Glyph name={g} size={13} />}{label ?? LABEL[state]}</span>;
}
