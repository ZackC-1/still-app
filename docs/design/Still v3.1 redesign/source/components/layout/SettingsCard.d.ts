import * as React from 'react';
/**
 * The raised card for everything below the service rows. New settings go in a new SettingsCard.
 * @startingPoint section="Layout" subtitle="Setting row, sync card and compact sync row" viewport="700x400"
 */
export interface SettingsCardProps {
  /** stack = section-label + content; row = title/sub + Toggle; sync-row = compact popup's one-line sync */
  variant?: 'stack' | 'row' | 'sync-row';
  /** section-label for stack */
  label?: string;
  /** card-title for row / sync-row; also the Toggle's accessible name */
  title?: string;
  /** row-sub line: one sentence stating the outcome */
  sub?: string;
  checked?: boolean;
  onChange?: (next: boolean) => void;
  /** Right-side action for sync-row, e.g. <Button inline> */
  action?: React.ReactNode;
  children?: React.ReactNode;
}
export declare function SettingsCard(props: SettingsCardProps): JSX.Element;
/** Hairline-topped group of account links inside a stack card */
export declare function AccountLinks(props: { children?: React.ReactNode }): JSX.Element;
