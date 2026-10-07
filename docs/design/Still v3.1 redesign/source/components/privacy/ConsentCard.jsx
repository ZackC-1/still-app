import React from 'react';

export function ConsentCard({ title = 'Share your email and usage data with Still?', body, purposes = [], never = 'Still never tracks or monitors the website you visit', shareLabel = 'Share', declineLabel = "Don't share", onShare, onDecline, footnote = 'Optional. Signing in or buying Still Pro never turns this on. Still works the same either way, and you can change it in Settings on this device.' }) {
  const tid = 'consent-title';
  return (
    <section className="card card-stack" aria-labelledby={tid}>
      <h2 className="card-title" id={tid}>{title}</h2>
      {body && <p className="card-body">{body}</p>}
      {purposes.length > 0 && <ul className="purpose-list">{purposes.map(p => <li key={p.name}><span className="purpose-name">{p.name}</span><span>{p.text}</span></li>)}</ul>}
      <p className="card-body">{never}</p>
      <div className="choice-actions">
        <button type="button" className="secondary" onClick={onDecline}>{declineLabel}</button>
        <button type="button" className="secondary" onClick={onShare}>{shareLabel}</button>
      </div>
      {footnote && <p className="caption">{footnote}</p>}
    </section>
  );
}
