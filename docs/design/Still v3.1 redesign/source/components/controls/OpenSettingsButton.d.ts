import * as React from 'react';
/**
 * The compact popup footer link that opens settings and the setup guide.
 */
export interface OpenSettingsButtonProps {
  /** Appended to the accessible name, e.g. "Find Still in Chrome." */
  setupTitle?: string;
  onClick?: () => void;
  /** Visible text; defaults to "Settings" */
  children?: React.ReactNode;
}
export declare function OpenSettingsButton(props: OpenSettingsButtonProps): JSX.Element;
