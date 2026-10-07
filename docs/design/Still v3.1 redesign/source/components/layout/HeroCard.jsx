import React from 'react';
import { Toggle } from '../controls/Toggle.jsx';

export function HeroCard({ on = true, onChange, compact = false, title, body }) {
  const t = title ?? (on ? 'Still is active' : 'Still is off');
  const b = body ?? (on ? 'Short-form video is removed on enabled sites.' : 'Your choices are saved. Turn Still on to remove short-form video.');
  return (
    <section className={['hero', !on && 'off', compact && 'compact'].filter(Boolean).join(' ')}>
      <div className="hero-text">
        <h1>{t}</h1>
        {!compact && <p>{b}</p>}
      </div>
      <Toggle checked={on} onChange={onChange} label="Still" variant={on ? 'on-blue' : 'default'} />
    </section>
  );
}
