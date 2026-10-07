import * as React from 'react';
/** Centered modal confirmation. Focus starts on the safe choice (cancel), Tab is trapped, Escape and scrim cancel, focus returns to the opener. */
export interface DialogProps {
  open?: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  onConfirm?: () => void;
  cancelLabel?: string;
  onCancel?: () => void;
  tone?: 'default' | 'danger';
  /** Position inside the parent instead of the viewport (specimens) */
  contained?: boolean;
  /** Set false for static specimens so the page doesn't move focus on load */
  trapFocus?: boolean;
  children?: React.ReactNode;
}
export declare function Dialog(props: DialogProps): JSX.Element | null;
