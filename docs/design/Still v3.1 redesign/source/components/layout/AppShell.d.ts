import * as React from 'react';
/**
 * The single-column Still app column (.still-ui .app). Order inside: app bar, HeroCard, site sections, settings cards, sync/account, footer.
 */
export interface AppShellProps {
  /** compact = the browser popups (tighter spacing, grouped sites, bounded scroll) */
  density?: 'comfortable' | 'compact';
  /** apple = iPhone/iPad/Mac host window: honours safe-area insets */
  host?: 'browser' | 'safari' | 'apple';
  /** Override max inline size in px (380 for the popup; default 432) */
  width?: number;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}
export declare function AppShell(props: AppShellProps): JSX.Element;
