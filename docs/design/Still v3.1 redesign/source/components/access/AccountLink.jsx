import React from 'react';
import { Button } from '../controls/Button.jsx';
import { StatusLine } from '../feedback/StatusLine.jsx';

export function AccountLink({ state = 'confirm', email, onConfirm, onChooseOther, onRetry, signOutNote = true }) {
  return (
    <section className="card card-stack" aria-label="Link Still Pro">
      {state === 'confirm' && <>
        <h2 className="card-title">Link Still Pro to this account?</h2>
        <p className="synced">{email}</p>
        <p className="card-body">You'll use this account to restore Still Pro in other browsers.</p>
        <Button block onClick={onConfirm}>Link to this account</Button>
        <Button variant="link" center onClick={onChooseOther}>Use a different account</Button>
      </>}
      {state === 'pending' && <StatusLine tone="pending">Linking Still Pro to {email}…</StatusLine>}
      {state === 'linked' && <StatusLine tone="success">Still Pro is linked to {email}.</StatusLine>}
      {state === 'failed' && <StatusLine tone="failed" detail="Still Pro still works on this device." actionLabel="Try again" onAction={onRetry}>Linking didn't finish.</StatusLine>}
      {signOutNote && state === 'linked' && <p className="caption">Signing out removes account access here. A purchase made on this device keeps working.</p>}
    </section>
  );
}
