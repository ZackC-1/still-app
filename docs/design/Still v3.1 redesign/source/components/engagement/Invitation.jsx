import React from 'react';
import { Button } from '../controls/Button.jsx';

const COPY = {
  sync: ['Use the same settings in every browser', 'Sign in for free settings sync. Optional.', 'Sign in'],
  link: ['Link Still Pro to an account', 'So you can restore it in other browsers. Optional.', 'Link'],
  rating: ['Rate Still', 'A rating helps other people find Still.', 'Rate Still'],
};

export function Invitation({ kind = 'sync', store = 'the Chrome Web Store', title, body, actionLabel, onAccept, onDismiss, dismissLabel = 'Not now' }) {
  const c = COPY[kind] || COPY.sync;
  return (
    <section className="card card-stack" aria-label={title ?? c[0]}>
      <div className="sync-row-text"><h2 className="sync-row-title">{title ?? c[0]}</h2><p className="muted sync-row-sub">{body ?? c[1].replace('{store}', store)}</p></div>
      <div className="inline-actions"><Button inline onClick={onAccept}>{actionLabel ?? c[2]}</Button><Button variant="link" onClick={onDismiss}>{dismissLabel}</Button></div>
    </section>
  );
}
