import React from 'react';

export function AppShell({ density = 'comfortable', host, width, children, style }) {
  const s = { ...(width ? { maxInlineSize: width + 'px' } : {}), ...style };
  return <div className="still-ui app" data-density={density === 'compact' ? 'compact' : undefined} data-host={host} style={s}>{children}</div>;
}
