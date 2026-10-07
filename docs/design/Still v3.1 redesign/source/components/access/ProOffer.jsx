import React from 'react';
import { Button } from '../controls/Button.jsx';
import { AccessTag } from './AccessTag.jsx';
import { StatusLine } from '../feedback/StatusLine.jsx';

function group(controls) {
  const m = new Map();
  controls.forEach(c => { if (!m.has(c.site)) m.set(c.site, []); m.get(c.site).push(c.label); });
  return [...m.entries()];
}

function List({ controls }) {
  if (!controls.length) return null;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{group(controls).map(([site, items]) => (
    <div key={site}><p className="offer-site">{site} Blocking Options</p><ul className="offer-list">{items.map(i => <li key={i}>{i}</li>)}</ul></div>
  ))}</div>;
}

export function ProOffer({ host = 'browser', offer, channel = 'ready', signedIn = false, ownership = 'none', state = 'idle', controls = [], showList = true, showPrice = true, onBuy, onSignIn, onRestore, onOpenHost, onRetry }) {
  const list = showList ? <List controls={controls} /> : null;
  if (host === 'safari') {
    return (
      <section className="card card-stack" aria-label="Still Pro">
        <div className="offer-head"><h2 className="card-title">Still Pro</h2><AccessTag state="locked" boxed /></div>
        <p className="card-body">These controls are included in Still Pro.</p>
        {list}
        <Button variant="secondary" block onClick={onOpenHost}>Open the Still app</Button>
      </section>
    );
  }
  if (ownership === 'owned') {
    return (
      <section className="card card-stack" aria-label="Still Pro">
        <div className="offer-head"><h2 className="card-title">Still Pro</h2><AccessTag state="purchased" boxed label="Purchased" /></div>
        <p className="card-body">You have Still Pro. New controls start off, so turn on the ones you want.</p>
      </section>
    );
  }
  if (ownership === 'checking') {
    return (
      <section className="card card-stack" aria-label="Still Pro">
        <h2 className="card-title">Still Pro</h2>
        <StatusLine tone="pending" detail="Your free controls keep working while this finishes.">Checking your Still Pro access…</StatusLine>
      </section>
    );
  }
  const canBuy = channel === 'ready' && offer && offer.price;
  const pending = state === 'pending';
  let cta;
  if (!canBuy) cta = <StatusLine tone="info" announce={false} detail="Already bought it somewhere else? Restore it below.">Still Pro can't be bought here yet.</StatusLine>;
  else if (host === 'browser' && !signedIn) cta = <Button block onClick={onSignIn}>Get Still Pro</Button>;
  else cta = <Button block onClick={pending ? undefined : onBuy} aria-busy={pending || undefined}>{pending ? (host === 'apple' ? 'Waiting for Apple…' : 'Waiting for checkout…') : 'Get Still Pro'}</Button>;
  return (
    <section className="card card-stack" aria-label="Still Pro">
      <div className="offer-head">
        <h2 className="card-title">Still Pro</h2>
        {canBuy && showPrice && <span className="offer-price">{offer.price}</span>}
      </div>
      {canBuy && offer.priceNote && <p className="card-body" style={{ marginBlockStart: -8 }}>{offer.priceNote}</p>}
      {list}
      {cta}
      {state === 'failed' && <StatusLine tone="failed" detail="If you were charged, Restore purchase will find it." actionLabel="Try again" onAction={onRetry}>The purchase wasn't confirmed.</StatusLine>}
      {state === 'success' && <StatusLine tone="success">Still Pro is ready. New controls start off.</StatusLine>}
      {canBuy && offer.refundNote && <p className="caption">{offer.refundNote}</p>}
      <Button variant="link" onClick={onRestore}>Restore purchase</Button>
    </section>
  );
}
