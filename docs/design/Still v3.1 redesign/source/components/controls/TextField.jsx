import React, { useId } from 'react';

export function TextField({ label, id, type = 'text', code = false, hint, error, className = '', ...rest }) {
  const auto = useId();
  const fid = id || auto;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {label && <label className="field-label" htmlFor={fid} style={{ marginBlockEnd: 'calc(-1 * var(--space-2))' }}>{label}</label>}
      <input id={fid} type={type} className={['field', code && 'code', className].filter(Boolean).join(' ')} inputMode={code ? 'numeric' : undefined} aria-label={label ? undefined : rest.placeholder} {...rest} />
      {error ? <p className="error" role="status">{error}</p> : hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}
