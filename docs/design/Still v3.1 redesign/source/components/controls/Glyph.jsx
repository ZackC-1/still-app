import React from 'react';

const P = {
  lock: <><rect x="3" y="9" width="14" height="10" rx="3"></rect><path d="M6 9V6a4 4 0 0 1 8 0v3"></path></>,
  chevron: <path d="M5 8l5 5 5-5"></path>,
  check: <path d="M4.5 10.5l3.5 3.5 7.5-8"></path>,
  alert: <><circle cx="10" cy="10" r="7.5"></circle><path d="M10 6v4.5"></path><path d="M10 13.6v.1"></path></>,
  clock: <><circle cx="10" cy="10" r="7.5"></circle><path d="M10 6v4l2.5 2"></path></>,
  spinner: <path d="M10 2.5a7.5 7.5 0 1 1-7.5 7.5"></path>,
  external: <><path d="M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"></path><path d="M11 4h5v5"></path><path d="M16 4l-7 7"></path></>,
};

export function Glyph({ name, size = 16, className, title }) {
  return (
    <svg className={className} viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : 'true'}>
      {P[name]}
    </svg>
  );
}
