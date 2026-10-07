import React from 'react';

export function OpenSettingsButton({ setupTitle = 'Find Still in Chrome.', onClick, children = 'Settings' }) {
  return <button type="button" className="open-options" aria-label={`${children}. ${setupTitle}`} onClick={onClick}>{children}</button>;
}
