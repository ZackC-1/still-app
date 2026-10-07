import * as React from 'react';
/**
 * Bottom sheet over a scrim for focused flows (sign-in, paywall). One primary button, a quiet dismiss.
 * @startingPoint section="Layout" subtitle="Bottom sheet for sign-in" viewport="700x380"
 */
export interface SheetProps {
  open?: boolean;
  /** sheet-title heading */
  title?: string;
  /** ink-secondary body line */
  body?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
  /** Position absolutely inside a relative parent instead of the viewport */
  contained?: boolean;
  children?: React.ReactNode;
}
export declare function Sheet(props: SheetProps): JSX.Element;
