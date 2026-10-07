import * as React from 'react';
/** One line for a real operation's state: pending, success, failed (with retry), caution (needs attention), info. Glyph + words carry the meaning; color only reinforces. */
export interface StatusLineProps {
  tone?: 'pending' | 'success' | 'failed' | 'caution' | 'info';
  children: React.ReactNode;
  /** Second line: what still works, what to do next */
  detail?: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  /** role=status / role=alert (failed). Set false for static specimens. */
  announce?: boolean;
}
export declare function StatusLine(props: StatusLineProps): JSX.Element;
