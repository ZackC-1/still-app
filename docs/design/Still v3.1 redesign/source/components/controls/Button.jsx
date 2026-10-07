import React from 'react';

const CLASS = { primary: 'primary', secondary: 'secondary', link: 'link', 'danger-link': 'link danger', 'danger-solid': 'danger-solid' };

export function Button({ variant = 'primary', block = false, inline = false, center = false, href, disabled, type = 'button', className = '', children, ...rest }) {
  const cls = [CLASS[variant] || 'primary', block && 'block', inline && 'inline', center && 'center', className].filter(Boolean).join(' ');
  if (href) return <a className={cls} href={href} {...rest}>{children}</a>;
  return <button type={type} className={cls} disabled={disabled} {...rest}>{children}</button>;
}
