import * as React from 'react';
/**
 * Email and one-time-code input from the sign-in sheet.
 */
export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** 14px/600 label above the field */
  label?: string;
  /** One-time code: 0.3em letter spacing, centered, numeric keypad */
  code?: boolean;
  /** 14px ink-secondary helper line */
  hint?: string;
  /** Danger-colored line with role="status"; replaces the hint */
  error?: string;
}
export declare function TextField(props: TextFieldProps): JSX.Element;
