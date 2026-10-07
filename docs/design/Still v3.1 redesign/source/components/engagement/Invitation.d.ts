/**
 * One unobtrusive optional invitation on a later ordinary opening: sync, purchase linking, or a browser-store rating (D28). Apple ratings use the native review UI instead.
 */
export interface InvitationProps {
  kind?: 'sync' | 'link' | 'rating';
  /** rating only: the store's name (used for the destination, not shown in copy) */
  store?: string;
  title?: string;
  body?: string;
  actionLabel?: string;
  onAccept?: () => void;
  onDismiss?: () => void;
  dismissLabel?: string;
}
export declare function Invitation(props: InvitationProps): JSX.Element;
