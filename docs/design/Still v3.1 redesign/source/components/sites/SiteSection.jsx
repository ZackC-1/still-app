import React from 'react';
import { Toggle } from '../controls/Toggle.jsx';
import { Glyph } from '../controls/Glyph.jsx';
import { ServiceIcon } from '../layout/ServiceIcon.jsx';
import { SwitchRow } from './SwitchRow.jsx';
import { SiteInventory } from './SiteInventory.js';

export function SiteSection({ service, serviceOn, onServiceChange, coreOn, onCoreChange, values = {}, access = {}, onControlChange, open = false, onToggleOpen, paused = false, host = 'browser', showSubs = true, onAccessAction, controls }) {
  const site = SiteInventory[service] || { controls: [] };
  const list = controls ?? site.controls;
  const multi = list.length > 0;
  const svcOn = serviceOn ?? coreOn ?? true;
  const onSvc = onServiceChange ?? onCoreChange;
  const panel = 'site-' + service + '-panel', head = 'site-' + service + '-h';
  const text = <span className="text"><span className="name" id={head}>{site.title ?? site.name}</span></span>;
  return (
    <div className="site-section" data-paused={paused || undefined}>
      <div className="service-row">
        <span className="icon"><ServiceIcon service={service} /></span>
        {multi
          ? <button type="button" className="expander" aria-expanded={open} aria-controls={panel} onClick={onToggleOpen}>{text}<Glyph name="chevron" className="chevron" /></button>
          : <div className="expander" style={{ cursor: 'default' }}>{text}</div>}
        <Toggle checked={svcOn} onChange={onSvc} disabled={paused} label={site.service} />
      </div>
      {multi && (
        <div id={panel} className={open ? 'service-options open' : 'service-options'} role="group" aria-labelledby={head}>
          <div className="inner"><div className="list">
            {list.map(c => (
              <SwitchRow key={c.id} id={c.id} label={c.label} sub={showSubs ? c.sub : undefined} checked={values[c.id] ?? !!c.defaultOn} access={c.free ? 'free' : (access[c.id] ?? 'checking')} inactive={paused || !svcOn} host={host}
                onChange={v => onControlChange && onControlChange(c.id, v)} onAccessAction={() => onAccessAction && onAccessAction(c.id)} />
            ))}
          </div></div>
        </div>
      )}
    </div>
  );
}

export function SiteList({ children, paused = false, scroll = false }) {
  const kids = React.Children.toArray(children).filter(Boolean);
  return (
    <div className={scroll ? 'service-group site-scroll services' : 'service-group services'} data-paused={paused || undefined}>
      {kids.map((k, i) => <React.Fragment key={i}>{i > 0 && <div className="divider"></div>}{k}</React.Fragment>)}
    </div>
  );
}
