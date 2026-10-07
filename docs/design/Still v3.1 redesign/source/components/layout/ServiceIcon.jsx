import React from 'react';
import { serviceIconSrc } from './serviceIconData.js';

export function ServiceIcon({ service, size }) {
  const st = size ? { inlineSize: size, blockSize: size, display: 'block', flex: 'none' } : { display: 'block', inlineSize: '100%', blockSize: '100%' };
  return <img src={serviceIconSrc[service]} alt="" style={st} />;
}
