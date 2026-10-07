import React from 'react';

export function DemoMark({ children = 'Demonstration only' }) {
  return <span className="demo-mark">{children}</span>;
}
