import React, { useState } from 'react';
import { Logo } from '../brand/Logo.jsx';
import { Button } from '../controls/Button.jsx';
import { Dialog } from '../layout/Dialog.jsx';
import { StatusLine } from '../feedback/StatusLine.jsx';

export function TikTokBlocked({ host = 'browser', state = 'blocked', confirmOpen, onOpenOnce, onOpenSettings, onReload, contained = false, style }) {
  const [inner, setInner] = useState(false);
  const open = confirmOpen ?? inner;
  const close = () => setInner(false);
  return (
    <main className="still-ui blocked" style={{ position: contained ? 'relative' : undefined, ...style }}>
      <Logo size={44} markOnly />
      <h1>TikTok stays closed.</h1>
      {state === 'reload' ? (
        <div className="blocked-actions">
          <StatusLine tone="info" announce={false}>Reload this page to open TikTok.</StatusLine>
          <Button onClick={onReload}>Reload page</Button>
        </div>
      ) : (
        <div className="blocked-actions">
          <button type="button" className="secondary" onClick={() => setInner(true)}>Open TikTok this time</button>
          {host === 'ios'
            ? <p className="manual">To change this, open the Still app and turn off TikTok website.</p>
            : <button type="button" className="link center" onClick={onOpenSettings}>Change this in Still settings</button>}
        </div>
      )}
      <Dialog open={open} contained={contained} title="Open TikTok in this tab?" body="TikTok opens in this tab until you close it. Other tabs stay closed, and your setting doesn't change." confirmLabel="Open TikTok this time" cancelLabel="Keep it closed" onConfirm={() => { close(); onOpenOnce && onOpenOnce(); }} onCancel={close} />
    </main>
  );
}
