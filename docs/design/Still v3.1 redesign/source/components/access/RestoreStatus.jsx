import React from 'react';
import { StatusLine } from '../feedback/StatusLine.jsx';

const R = {
  checking: ['pending', 'Checking for Still Pro purchases…'],
  restored: ['success', 'Still Pro is restored on this device.'],
  nothing: ['info', 'No Still Pro purchase was found for this account.', 'Bought it with another account or Apple ID? Sign in with that one and try again.'],
  failed: ['failed', "We couldn't finish checking. Nothing changed.", 'Your free controls and saved choices are unaffected.', 'Try again'],
  verify: ['caution', 'Still Pro needs to be verified again.', 'Go online and sign in. Free controls and your saved choices stay.', 'Verify now'],
};

export function RestoreStatus({ state = 'checking', onAction, announce = true }) {
  const [tone, text, detail, action] = R[state] || R.checking;
  return <StatusLine tone={tone} detail={detail} actionLabel={action} onAction={onAction} announce={announce}>{text}</StatusLine>;
}
