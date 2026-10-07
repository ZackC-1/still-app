/**
 * The one optional combined email-plus-usage choice (D36/D37), composed into an existing screen. Equal Share / Don't share. Never shown as a separate privacy screen, never implied by sign-in or purchase.
 */
export interface ConsentCardProps {
  title?: string;
  body?: string;
  /** Exact purposes from the approved list (analytics, AI), each named with what it does */
  purposes?: { name: string; text: string }[];
  never?: string;
  shareLabel?: string;
  declineLabel?: string;
  onShare?: () => void;
  onDecline?: () => void;
  footnote?: string;
}
export declare function ConsentCard(props: ConsentCardProps): JSX.Element;
