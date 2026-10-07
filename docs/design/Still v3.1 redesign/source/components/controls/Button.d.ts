import * as React from 'react';
/**
 * Still's four button looks. One primary per card at most.
 * @startingPoint section="Controls" subtitle="Primary, secondary, link and destructive buttons" viewport="700x260"
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = still-blue fill; secondary = hairline outline; link = tertiary text; danger-* = account deletion only */
  variant?: 'primary' | 'secondary' | 'link' | 'danger-link' | 'danger-solid';
  /** Full width, 44px min height (primary/secondary) */
  block?: boolean;
  /** Small 36px button for the compact sync row (primary) */
  inline?: boolean;
  /** Center a link in its column */
  center?: boolean;
  /** Render as <a> */
  href?: string;
  children?: React.ReactNode;
}
export declare function Button(props: ButtonProps): JSX.Element;
