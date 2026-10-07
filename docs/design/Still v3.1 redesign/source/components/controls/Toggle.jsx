import React, { useState } from 'react';

export function Toggle({ checked, defaultChecked = false, onChange, label, labelledBy, describedBy, disabled = false, variant = 'default', size = 'default' }) {
  const [inner, setInner] = useState(defaultChecked);
  const on = checked ?? inner;
  const cls = ['toggle', variant === 'on-blue' && 'on-blue', size === 'small' && 'small', on && 'on'].filter(Boolean).join(' ');
  const click = () => { if (disabled) return; if (checked === undefined) setInner(!on); onChange && onChange(!on); };
  return (
    <button type="button" className={cls} role="switch" aria-checked={on} aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-disabled={disabled || undefined} onClick={click}>
      <span className="knob"></span>
    </button>
  );
}
