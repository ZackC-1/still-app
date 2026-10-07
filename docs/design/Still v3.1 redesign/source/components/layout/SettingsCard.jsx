import React from 'react';
import { Toggle } from '../controls/Toggle.jsx';

export function SettingsCard({ variant = 'stack', label, title, sub, checked, onChange, action, children }) {
  if (variant === 'row') {
    return (
      <section className="card setting-row">
        <div className="row-text"><span className="row-title">{title}</span>{sub && <span className="row-sub">{sub}</span>}</div>
        <Toggle checked={checked} onChange={onChange} label={title} />
      </section>
    );
  }
  if (variant === 'sync-row') {
    return (
      <section className="card card-stack">
        <div className="sync-row">
          <div className="sync-row-text"><h2 className="sync-row-title">{title}</h2>{sub && <p className="muted sync-row-sub">{sub}</p>}</div>
          {action}
        </div>
        {children}
      </section>
    );
  }
  return (
    <section className="card card-stack">
      {label && <h2 className="section-label">{label}</h2>}
      {children}
    </section>
  );
}

export function AccountLinks({ children }) {
  return <div className="account">{children}</div>;
}
