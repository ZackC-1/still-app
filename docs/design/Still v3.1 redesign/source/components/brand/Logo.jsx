import React from 'react';
import { wordmarkSrc } from './wordmarkData.js';

export function Logo({ size, compact = false, markOnly = false }) {
  const style = {};
  if (compact) { style['--logo-mark-size'] = '24px'; style['--logo-word-size'] = '18px'; }
  if (size) { style['--logo-mark-size'] = size + 'px'; style['--logo-word-size'] = Math.round(size * 22 / 28) + 'px'; }
  return (
    <div className="still-logo" role="img" aria-label="Still" translate="no" style={style}>
      <svg className="mark" viewBox="0 0 48 48" aria-hidden="true">
        <rect width="48" height="48" rx="13" fill="var(--still-blue)"></rect>
        <line x1="9" y1="30" x2="39" y2="30" stroke="#fff" strokeWidth="2.4" strokeLinecap="round"></line>
        <circle cx="24" cy="26.4" r="3.6" fill="#fff"></circle>
      </svg>
      {!markOnly && <img className="word" src={wordmarkSrc} alt="" />}
    </div>
  );
}
