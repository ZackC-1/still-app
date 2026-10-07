/** Optional purchase-to-account linking with intended-account confirmation (D10/D11). Link, transfer and purchase are different outcomes. */
export interface AccountLinkProps {
  state?: 'confirm' | 'pending' | 'linked' | 'failed';
  email: string;
  onConfirm?: () => void;
  onChooseOther?: () => void;
  onRetry?: () => void;
  /** Explain that sign-out clears account access but keeps device-valid purchases */
  signOutNote?: boolean;
}
export declare function AccountLink(props: AccountLinkProps): JSX.Element;
