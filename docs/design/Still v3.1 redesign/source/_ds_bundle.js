/* @ds-bundle: {"format":4,"namespace":"StillDesignSystem_c8e8ab","components":[{"name":"AccessTag","sourcePath":"components/access/AccessTag.jsx"},{"name":"AccountLink","sourcePath":"components/access/AccountLink.jsx"},{"name":"ProOffer","sourcePath":"components/access/ProOffer.jsx"},{"name":"RestoreStatus","sourcePath":"components/access/RestoreStatus.jsx"},{"name":"TikTokBlocked","sourcePath":"components/blocked/TikTokBlocked.jsx"},{"name":"Logo","sourcePath":"components/brand/Logo.jsx"},{"name":"Button","sourcePath":"components/controls/Button.jsx"},{"name":"Glyph","sourcePath":"components/controls/Glyph.jsx"},{"name":"OpenSettingsButton","sourcePath":"components/controls/OpenSettingsButton.jsx"},{"name":"TextField","sourcePath":"components/controls/TextField.jsx"},{"name":"Toggle","sourcePath":"components/controls/Toggle.jsx"},{"name":"Invitation","sourcePath":"components/engagement/Invitation.jsx"},{"name":"OwnerAllowances","sourcePath":"components/engagement/OwnerAllowances.jsx"},{"name":"DemoMark","sourcePath":"components/feedback/DemoMark.jsx"},{"name":"StatusLine","sourcePath":"components/feedback/StatusLine.jsx"},{"name":"AppShell","sourcePath":"components/layout/AppShell.jsx"},{"name":"Dialog","sourcePath":"components/layout/Dialog.jsx"},{"name":"HeroCard","sourcePath":"components/layout/HeroCard.jsx"},{"name":"ServiceIcon","sourcePath":"components/layout/ServiceIcon.jsx"},{"name":"SettingsCard","sourcePath":"components/layout/SettingsCard.jsx"},{"name":"AccountLinks","sourcePath":"components/layout/SettingsCard.jsx"},{"name":"Sheet","sourcePath":"components/layout/Sheet.jsx"},{"name":"ConsentCard","sourcePath":"components/privacy/ConsentCard.jsx"},{"name":"SharingSetting","sourcePath":"components/privacy/SharingSetting.jsx"},{"name":"SiteInventory","sourcePath":"components/sites/SiteInventory.js"},{"name":"SiteOrder","sourcePath":"components/sites/SiteInventory.js"},{"name":"ProControlList","sourcePath":"components/sites/SiteInventory.js"},{"name":"SiteSection","sourcePath":"components/sites/SiteSection.jsx"},{"name":"SiteList","sourcePath":"components/sites/SiteSection.jsx"},{"name":"SwitchRow","sourcePath":"components/sites/SwitchRow.jsx"}],"sourceHashes":{"components/access/AccessTag.jsx":"bf5025392e23","components/access/AccountLink.jsx":"428539eb5b25","components/access/ProOffer.jsx":"bf46731a2fb1","components/access/RestoreStatus.jsx":"d4374d1dd66d","components/blocked/TikTokBlocked.jsx":"60942563d4da","components/brand/Logo.jsx":"5b239ccefadf","components/brand/wordmarkData.js":"1d5ec3c214ec","components/controls/Button.jsx":"b64cb02615b8","components/controls/Glyph.jsx":"82caaf6ac0f2","components/controls/OpenSettingsButton.jsx":"2cc488eb6829","components/controls/TextField.jsx":"445d7c71764e","components/controls/Toggle.jsx":"95691d9cc756","components/engagement/Invitation.jsx":"80ad81b8df78","components/engagement/OwnerAllowances.jsx":"d0e12c9f0953","components/feedback/DemoMark.jsx":"f3d105517a06","components/feedback/StatusLine.jsx":"e47c4ed1917e","components/layout/AppShell.jsx":"6a1a7b9b9b5a","components/layout/Dialog.jsx":"ae42d910a2a7","components/layout/HeroCard.jsx":"babc593c8712","components/layout/ServiceIcon.jsx":"5123cf1db22f","components/layout/SettingsCard.jsx":"91c82fc02008","components/layout/Sheet.jsx":"1c9b715480f1","components/layout/serviceIconData.js":"116fe02e449f","components/layout/useModalFocus.js":"0b59af9557a2","components/privacy/ConsentCard.jsx":"7759df8660a9","components/privacy/SharingSetting.jsx":"004c1af4492d","components/sites/SiteInventory.js":"eae3aba6755c","components/sites/SiteSection.jsx":"baa90d82403d","components/sites/SwitchRow.jsx":"381a535a95ee"},"inlinedExternals":[],"unexposedExports":[{"name":"serviceIconSrc","sourcePath":"components/layout/serviceIconData.js"},{"name":"useModalFocus","sourcePath":"components/layout/useModalFocus.js"},{"name":"wordmarkSrc","sourcePath":"components/brand/wordmarkData.js"}]} */

(() => {

const __ds_ns = (window.StillDesignSystem_c8e8ab = window.StillDesignSystem_c8e8ab || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/brand/wordmarkData.js
try { (() => {
// Generated from assets/logos/still-wordmark.png (as in wordmark.ts).
const wordmarkSrc = "data:image/png;base64,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";
Object.assign(__ds_scope, { wordmarkSrc });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/wordmarkData.js", error: String((e && e.message) || e) }); }

// components/brand/Logo.jsx
try { (() => {
function Logo({
  size,
  compact = false,
  markOnly = false
}) {
  const style = {};
  if (compact) {
    style['--logo-mark-size'] = '24px';
    style['--logo-word-size'] = '18px';
  }
  if (size) {
    style['--logo-mark-size'] = size + 'px';
    style['--logo-word-size'] = Math.round(size * 22 / 28) + 'px';
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "still-logo",
    role: "img",
    "aria-label": "Still",
    translate: "no",
    style: style
  }, /*#__PURE__*/React.createElement("svg", {
    className: "mark",
    viewBox: "0 0 48 48",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("rect", {
    width: "48",
    height: "48",
    rx: "13",
    fill: "var(--still-blue)"
  }), /*#__PURE__*/React.createElement("line", {
    x1: "9",
    y1: "30",
    x2: "39",
    y2: "30",
    stroke: "#fff",
    strokeWidth: "2.4",
    strokeLinecap: "round"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "24",
    cy: "26.4",
    r: "3.6",
    fill: "#fff"
  })), !markOnly && /*#__PURE__*/React.createElement("img", {
    className: "word",
    src: __ds_scope.wordmarkSrc,
    alt: ""
  }));
}
Object.assign(__ds_scope, { Logo });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/Logo.jsx", error: String((e && e.message) || e) }); }

// components/controls/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CLASS = {
  primary: 'primary',
  secondary: 'secondary',
  link: 'link',
  'danger-link': 'link danger',
  'danger-solid': 'danger-solid'
};
function Button({
  variant = 'primary',
  block = false,
  inline = false,
  center = false,
  href,
  disabled,
  type = 'button',
  className = '',
  children,
  ...rest
}) {
  const cls = [CLASS[variant] || 'primary', block && 'block', inline && 'inline', center && 'center', className].filter(Boolean).join(' ');
  if (href) return /*#__PURE__*/React.createElement("a", _extends({
    className: cls,
    href: href
  }, rest), children);
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    className: cls,
    disabled: disabled
  }, rest), children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/controls/Button.jsx", error: String((e && e.message) || e) }); }

// components/controls/Glyph.jsx
try { (() => {
const P = {
  lock: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "9",
    width: "14",
    height: "10",
    rx: "3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M6 9V6a4 4 0 0 1 8 0v3"
  })),
  chevron: /*#__PURE__*/React.createElement("path", {
    d: "M5 8l5 5 5-5"
  }),
  check: /*#__PURE__*/React.createElement("path", {
    d: "M4.5 10.5l3.5 3.5 7.5-8"
  }),
  alert: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "10",
    cy: "10",
    r: "7.5"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M10 6v4.5"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M10 13.6v.1"
  })),
  clock: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "10",
    cy: "10",
    r: "7.5"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M10 6v4l2.5 2"
  })),
  spinner: /*#__PURE__*/React.createElement("path", {
    d: "M10 2.5a7.5 7.5 0 1 1-7.5 7.5"
  }),
  external: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M11 4h5v5"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M16 4l-7 7"
  }))
};
function Glyph({
  name,
  size = 16,
  className,
  title
}) {
  return /*#__PURE__*/React.createElement("svg", {
    className: className,
    viewBox: "0 0 20 20",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    role: title ? 'img' : undefined,
    "aria-label": title,
    "aria-hidden": title ? undefined : 'true'
  }, P[name]);
}
Object.assign(__ds_scope, { Glyph });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/controls/Glyph.jsx", error: String((e && e.message) || e) }); }

// components/access/AccessTag.jsx
try { (() => {
const LABEL = {
  protected: 'Yours to keep',
  purchased: 'Still Pro',
  checking: 'Checking access',
  verify: 'Needs verification',
  locked: 'Included in Still Pro',
  unsupported: 'Not available here'
};
const GLYPH = {
  locked: 'lock',
  checking: 'clock',
  verify: 'alert'
};
function AccessTag({
  state,
  label,
  boxed = false
}) {
  if (!state || state === 'free') return null;
  const g = GLYPH[state];
  return /*#__PURE__*/React.createElement("span", {
    className: boxed ? 'access-tag boxed' : 'access-tag'
  }, g && /*#__PURE__*/React.createElement(__ds_scope.Glyph, {
    name: g,
    size: 13
  }), label ?? LABEL[state]);
}
Object.assign(__ds_scope, { AccessTag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/access/AccessTag.jsx", error: String((e && e.message) || e) }); }

// components/controls/OpenSettingsButton.jsx
try { (() => {
function OpenSettingsButton({
  setupTitle = 'Find Still in Chrome.',
  onClick,
  children = 'Settings'
}) {
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "open-options",
    "aria-label": `${children}. ${setupTitle}`,
    onClick: onClick
  }, children);
}
Object.assign(__ds_scope, { OpenSettingsButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/controls/OpenSettingsButton.jsx", error: String((e && e.message) || e) }); }

// components/controls/TextField.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  useId
} = React;
function TextField({
  label,
  id,
  type = 'text',
  code = false,
  hint,
  error,
  className = '',
  ...rest
}) {
  const auto = useId();
  const fid = id || auto;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-3)'
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    className: "field-label",
    htmlFor: fid,
    style: {
      marginBlockEnd: 'calc(-1 * var(--space-2))'
    }
  }, label), /*#__PURE__*/React.createElement("input", _extends({
    id: fid,
    type: type,
    className: ['field', code && 'code', className].filter(Boolean).join(' '),
    inputMode: code ? 'numeric' : undefined,
    "aria-label": label ? undefined : rest.placeholder
  }, rest)), error ? /*#__PURE__*/React.createElement("p", {
    className: "error",
    role: "status"
  }, error) : hint ? /*#__PURE__*/React.createElement("p", {
    className: "hint"
  }, hint) : null);
}
Object.assign(__ds_scope, { TextField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/controls/TextField.jsx", error: String((e && e.message) || e) }); }

// components/controls/Toggle.jsx
try { (() => {
const {
  useState
} = React;
function Toggle({
  checked,
  defaultChecked = false,
  onChange,
  label,
  labelledBy,
  describedBy,
  disabled = false,
  variant = 'default',
  size = 'default'
}) {
  const [inner, setInner] = useState(defaultChecked);
  const on = checked ?? inner;
  const cls = ['toggle', variant === 'on-blue' && 'on-blue', size === 'small' && 'small', on && 'on'].filter(Boolean).join(' ');
  const click = () => {
    if (disabled) return;
    if (checked === undefined) setInner(!on);
    onChange && onChange(!on);
  };
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: cls,
    role: "switch",
    "aria-checked": on,
    "aria-label": labelledBy ? undefined : label,
    "aria-labelledby": labelledBy,
    "aria-describedby": describedBy,
    "aria-disabled": disabled || undefined,
    onClick: click
  }, /*#__PURE__*/React.createElement("span", {
    className: "knob"
  }));
}
Object.assign(__ds_scope, { Toggle });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/controls/Toggle.jsx", error: String((e && e.message) || e) }); }

// components/engagement/Invitation.jsx
try { (() => {
const COPY = {
  sync: ['Use the same settings in every browser', 'Sign in for free settings sync. Optional.', 'Sign in'],
  link: ['Link Still Pro to an account', 'So you can restore it in other browsers. Optional.', 'Link'],
  rating: ['Rate Still', 'A rating helps other people find Still.', 'Rate Still']
};
function Invitation({
  kind = 'sync',
  store = 'the Chrome Web Store',
  title,
  body,
  actionLabel,
  onAccept,
  onDismiss,
  dismissLabel = 'Not now'
}) {
  const c = COPY[kind] || COPY.sync;
  return /*#__PURE__*/React.createElement("section", {
    className: "card card-stack",
    "aria-label": title ?? c[0]
  }, /*#__PURE__*/React.createElement("div", {
    className: "sync-row-text"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "sync-row-title"
  }, title ?? c[0]), /*#__PURE__*/React.createElement("p", {
    className: "muted sync-row-sub"
  }, body ?? c[1].replace('{store}', store))), /*#__PURE__*/React.createElement("div", {
    className: "inline-actions"
  }, /*#__PURE__*/React.createElement(__ds_scope.Button, {
    inline: true,
    onClick: onAccept
  }, actionLabel ?? c[2]), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "link",
    onClick: onDismiss
  }, dismissLabel)));
}
Object.assign(__ds_scope, { Invitation });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/engagement/Invitation.jsx", error: String((e && e.message) || e) }); }

// components/feedback/DemoMark.jsx
try { (() => {
function DemoMark({
  children = 'Demonstration only'
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: "demo-mark"
  }, children);
}
Object.assign(__ds_scope, { DemoMark });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/DemoMark.jsx", error: String((e && e.message) || e) }); }

// components/feedback/StatusLine.jsx
try { (() => {
const G = {
  pending: 'spinner',
  success: 'check',
  failed: 'alert',
  caution: 'clock',
  info: null
};
function StatusLine({
  tone = 'info',
  children,
  detail,
  actionLabel,
  onAction,
  announce = true
}) {
  const role = !announce ? undefined : tone === 'failed' ? 'alert' : 'status';
  return /*#__PURE__*/React.createElement("div", {
    className: "status-line",
    "data-tone": tone,
    role: role
  }, G[tone] && /*#__PURE__*/React.createElement("span", {
    className: "glyph"
  }, /*#__PURE__*/React.createElement(__ds_scope.Glyph, {
    name: G[tone],
    size: 16
  })), /*#__PURE__*/React.createElement("div", {
    className: "status-body"
  }, /*#__PURE__*/React.createElement("span", null, children), detail && /*#__PURE__*/React.createElement("span", {
    className: "muted",
    style: {
      fontSize: 'calc(12.5px * var(--text-scale, 1))'
    }
  }, detail), actionLabel && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "link status-action",
    onClick: onAction
  }, actionLabel)));
}
Object.assign(__ds_scope, { StatusLine });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/StatusLine.jsx", error: String((e && e.message) || e) }); }

// components/access/AccountLink.jsx
try { (() => {
function AccountLink({
  state = 'confirm',
  email,
  onConfirm,
  onChooseOther,
  onRetry,
  signOutNote = true
}) {
  return /*#__PURE__*/React.createElement("section", {
    className: "card card-stack",
    "aria-label": "Link Still Pro"
  }, state === 'confirm' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h2", {
    className: "card-title"
  }, "Link Still Pro to this account?"), /*#__PURE__*/React.createElement("p", {
    className: "synced"
  }, email), /*#__PURE__*/React.createElement("p", {
    className: "card-body"
  }, "You'll use this account to restore Still Pro in other browsers."), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    block: true,
    onClick: onConfirm
  }, "Link to this account"), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "link",
    center: true,
    onClick: onChooseOther
  }, "Use a different account")), state === 'pending' && /*#__PURE__*/React.createElement(__ds_scope.StatusLine, {
    tone: "pending"
  }, "Linking Still Pro to ", email, "\u2026"), state === 'linked' && /*#__PURE__*/React.createElement(__ds_scope.StatusLine, {
    tone: "success"
  }, "Still Pro is linked to ", email, "."), state === 'failed' && /*#__PURE__*/React.createElement(__ds_scope.StatusLine, {
    tone: "failed",
    detail: "Still Pro still works on this device.",
    actionLabel: "Try again",
    onAction: onRetry
  }, "Linking didn't finish."), signOutNote && state === 'linked' && /*#__PURE__*/React.createElement("p", {
    className: "caption"
  }, "Signing out removes account access here. A purchase made on this device keeps working."));
}
Object.assign(__ds_scope, { AccountLink });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/access/AccountLink.jsx", error: String((e && e.message) || e) }); }

// components/access/ProOffer.jsx
try { (() => {
function group(controls) {
  const m = new Map();
  controls.forEach(c => {
    if (!m.has(c.site)) m.set(c.site, []);
    m.get(c.site).push(c.label);
  });
  return [...m.entries()];
}
function List({
  controls
}) {
  if (!controls.length) return null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, group(controls).map(([site, items]) => /*#__PURE__*/React.createElement("div", {
    key: site
  }, /*#__PURE__*/React.createElement("p", {
    className: "offer-site"
  }, site, " Blocking Options"), /*#__PURE__*/React.createElement("ul", {
    className: "offer-list"
  }, items.map(i => /*#__PURE__*/React.createElement("li", {
    key: i
  }, i))))));
}
function ProOffer({
  host = 'browser',
  offer,
  channel = 'ready',
  signedIn = false,
  ownership = 'none',
  state = 'idle',
  controls = [],
  showList = true,
  showPrice = true,
  onBuy,
  onSignIn,
  onRestore,
  onOpenHost,
  onRetry
}) {
  const list = showList ? /*#__PURE__*/React.createElement(List, {
    controls: controls
  }) : null;
  if (host === 'safari') {
    return /*#__PURE__*/React.createElement("section", {
      className: "card card-stack",
      "aria-label": "Still Pro"
    }, /*#__PURE__*/React.createElement("div", {
      className: "offer-head"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "card-title"
    }, "Still Pro"), /*#__PURE__*/React.createElement(__ds_scope.AccessTag, {
      state: "locked",
      boxed: true
    })), /*#__PURE__*/React.createElement("p", {
      className: "card-body"
    }, "These controls are included in Still Pro."), list, /*#__PURE__*/React.createElement(__ds_scope.Button, {
      variant: "secondary",
      block: true,
      onClick: onOpenHost
    }, "Open the Still app"));
  }
  if (ownership === 'owned') {
    return /*#__PURE__*/React.createElement("section", {
      className: "card card-stack",
      "aria-label": "Still Pro"
    }, /*#__PURE__*/React.createElement("div", {
      className: "offer-head"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "card-title"
    }, "Still Pro"), /*#__PURE__*/React.createElement(__ds_scope.AccessTag, {
      state: "purchased",
      boxed: true,
      label: "Purchased"
    })), /*#__PURE__*/React.createElement("p", {
      className: "card-body"
    }, "You have Still Pro. New controls start off, so turn on the ones you want."));
  }
  if (ownership === 'checking') {
    return /*#__PURE__*/React.createElement("section", {
      className: "card card-stack",
      "aria-label": "Still Pro"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "card-title"
    }, "Still Pro"), /*#__PURE__*/React.createElement(__ds_scope.StatusLine, {
      tone: "pending",
      detail: "Your free controls keep working while this finishes."
    }, "Checking your Still Pro access\u2026"));
  }
  const canBuy = channel === 'ready' && offer && offer.price;
  const pending = state === 'pending';
  let cta;
  if (!canBuy) cta = /*#__PURE__*/React.createElement(__ds_scope.StatusLine, {
    tone: "info",
    announce: false,
    detail: "Already bought it somewhere else? Restore it below."
  }, "Still Pro can't be bought here yet.");else if (host === 'browser' && !signedIn) cta = /*#__PURE__*/React.createElement(__ds_scope.Button, {
    block: true,
    onClick: onSignIn
  }, "Get Still Pro");else cta = /*#__PURE__*/React.createElement(__ds_scope.Button, {
    block: true,
    onClick: pending ? undefined : onBuy,
    "aria-busy": pending || undefined
  }, pending ? host === 'apple' ? 'Waiting for Apple…' : 'Waiting for checkout…' : 'Get Still Pro');
  return /*#__PURE__*/React.createElement("section", {
    className: "card card-stack",
    "aria-label": "Still Pro"
  }, /*#__PURE__*/React.createElement("div", {
    className: "offer-head"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "card-title"
  }, "Still Pro"), canBuy && showPrice && /*#__PURE__*/React.createElement("span", {
    className: "offer-price"
  }, offer.price)), canBuy && offer.priceNote && /*#__PURE__*/React.createElement("p", {
    className: "card-body",
    style: {
      marginBlockStart: -8
    }
  }, offer.priceNote), list, cta, state === 'failed' && /*#__PURE__*/React.createElement(__ds_scope.StatusLine, {
    tone: "failed",
    detail: "If you were charged, Restore purchase will find it.",
    actionLabel: "Try again",
    onAction: onRetry
  }, "The purchase wasn't confirmed."), state === 'success' && /*#__PURE__*/React.createElement(__ds_scope.StatusLine, {
    tone: "success"
  }, "Still Pro is ready. New controls start off."), canBuy && offer.refundNote && /*#__PURE__*/React.createElement("p", {
    className: "caption"
  }, offer.refundNote), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "link",
    onClick: onRestore
  }, "Restore purchase"));
}
Object.assign(__ds_scope, { ProOffer });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/access/ProOffer.jsx", error: String((e && e.message) || e) }); }

// components/access/RestoreStatus.jsx
try { (() => {
const R = {
  checking: ['pending', 'Checking for Still Pro purchases…'],
  restored: ['success', 'Still Pro is restored on this device.'],
  nothing: ['info', 'No Still Pro purchase was found for this account.', 'Bought it with another account or Apple ID? Sign in with that one and try again.'],
  failed: ['failed', "We couldn't finish checking. Nothing changed.", 'Your free controls and saved choices are unaffected.', 'Try again'],
  verify: ['caution', 'Still Pro needs to be verified again.', 'Go online and sign in. Free controls and your saved choices stay.', 'Verify now']
};
function RestoreStatus({
  state = 'checking',
  onAction,
  announce = true
}) {
  const [tone, text, detail, action] = R[state] || R.checking;
  return /*#__PURE__*/React.createElement(__ds_scope.StatusLine, {
    tone: tone,
    detail: detail,
    actionLabel: action,
    onAction: onAction,
    announce: announce
  }, text);
}
Object.assign(__ds_scope, { RestoreStatus });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/access/RestoreStatus.jsx", error: String((e && e.message) || e) }); }

// components/engagement/OwnerAllowances.jsx
try { (() => {
const {
  useState
} = React;
const SURFACES = [{
  id: 'chrome',
  name: 'Chrome desktop'
}, {
  id: 'edge',
  name: 'Edge desktop',
  deferred: true
}, {
  id: 'firefox',
  name: 'Firefox desktop'
}, {
  id: 'firefox-android',
  name: 'Firefox Android'
}, {
  id: 'apple-mobile',
  name: 'Apple mobile host'
}, {
  id: 'apple-mac',
  name: 'Apple macOS host'
}];
const ST = {
  applying: ['pending', 'Applying…'],
  readback: ['pending', 'Reading back the saved allowances…'],
  applied: ['success', 'Applied and read back. The server matches.'],
  stale: ['caution', 'These changed since you loaded them. Reload to see the current state.', 'Reload'],
  failed: ['failed', "Apply didn't finish. Nothing changed.", 'Try again']
};
const onOff = v => v ? 'On' : 'Off';
function OwnerAllowances({
  surfaces = SURFACES,
  current = {},
  draft: draftProp,
  onDraftChange,
  state = 'idle',
  onApply,
  onDiscard,
  onStatusAction,
  announce = true
}) {
  const [inner, setInner] = useState(current);
  const draft = draftProp ?? inner;
  const set = (id, v) => {
    const d = {
      ...draft,
      [id]: v
    };
    if (!draftProp) setInner(d);
    onDraftChange && onDraftChange(d);
  };
  const changed = ['global', ...surfaces.map(s => s.id)].filter(k => !!draft[k] !== !!current[k]);
  const busy = state === 'applying' || state === 'readback';
  const live = surfaces.filter(s => !s.deferred && draft.global && draft[s.id]).map(s => s.name);
  const st = ST[state];
  const Row = ({
    id,
    name,
    deferred,
    inactive
  }) => /*#__PURE__*/React.createElement("div", {
    className: "allow-row",
    "data-inactive": inactive || undefined
  }, /*#__PURE__*/React.createElement("div", {
    className: "row-main"
  }, /*#__PURE__*/React.createElement("span", {
    className: "label"
  }, /*#__PURE__*/React.createElement("span", {
    id: 'al-' + id
  }, name), deferred && /*#__PURE__*/React.createElement("span", {
    className: "access-tag boxed"
  }, "Deferred"), !deferred && changed.includes(id) && /*#__PURE__*/React.createElement("span", {
    className: "access-tag boxed"
  }, "Changed"))), !deferred && /*#__PURE__*/React.createElement(__ds_scope.Toggle, {
    size: "small",
    checked: !!draft[id],
    onChange: v => set(id, v),
    disabled: busy,
    labelledBy: 'al-' + id
  }));
  return /*#__PURE__*/React.createElement("section", {
    className: "card card-stack",
    "aria-label": "Rating prompt allowances"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    }
  }, /*#__PURE__*/React.createElement("h2", {
    className: "card-title"
  }, "Rating prompt allowances"), /*#__PURE__*/React.createElement("p", {
    className: "card-body",
    style: {
      fontSize: 'calc(13px * var(--text-scale, 1))'
    }
  }, "Off everywhere until you allow it. Nothing changes until Apply.")), /*#__PURE__*/React.createElement("div", {
    className: "allow-list"
  }, /*#__PURE__*/React.createElement(Row, {
    id: "global",
    name: "All surfaces"
  }), surfaces.map(s => /*#__PURE__*/React.createElement(Row, {
    key: s.id,
    id: s.id,
    name: s.name,
    deferred: s.deferred,
    inactive: !draft.global
  }))), /*#__PURE__*/React.createElement("p", {
    className: "allow-preview"
  }, "After Apply, prompts are allowed on ", live.length ? /*#__PURE__*/React.createElement("strong", null, live.join(', ')) : /*#__PURE__*/React.createElement("strong", null, "no surfaces"), "."), st && /*#__PURE__*/React.createElement(__ds_scope.StatusLine, {
    tone: st[0],
    actionLabel: st[2],
    onAction: onStatusAction,
    announce: announce
  }, st[1]), /*#__PURE__*/React.createElement("div", {
    className: "inline-actions"
  }, /*#__PURE__*/React.createElement(__ds_scope.Button, {
    inline: true,
    disabled: !changed.length || busy,
    onClick: onApply
  }, "Apply"), changed.length > 0 && !busy && /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "link",
    onClick: () => {
      if (!draftProp) setInner(current);
      onDiscard && onDiscard();
    }
  }, "Discard changes")));
}
Object.assign(__ds_scope, { OwnerAllowances });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/engagement/OwnerAllowances.jsx", error: String((e && e.message) || e) }); }

// components/layout/AppShell.jsx
try { (() => {
function AppShell({
  density = 'comfortable',
  host,
  width,
  children,
  style
}) {
  const s = {
    ...(width ? {
      maxInlineSize: width + 'px'
    } : {}),
    ...style
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "still-ui app",
    "data-density": density === 'compact' ? 'compact' : undefined,
    "data-host": host,
    style: s
  }, children);
}
Object.assign(__ds_scope, { AppShell });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/AppShell.jsx", error: String((e && e.message) || e) }); }

// components/layout/HeroCard.jsx
try { (() => {
function HeroCard({
  on = true,
  onChange,
  compact = false,
  title,
  body
}) {
  const t = title ?? (on ? 'Still is active' : 'Still is off');
  const b = body ?? (on ? 'Short-form video is removed on enabled sites.' : 'Your choices are saved. Turn Still on to remove short-form video.');
  return /*#__PURE__*/React.createElement("section", {
    className: ['hero', !on && 'off', compact && 'compact'].filter(Boolean).join(' ')
  }, /*#__PURE__*/React.createElement("div", {
    className: "hero-text"
  }, /*#__PURE__*/React.createElement("h1", null, t), !compact && /*#__PURE__*/React.createElement("p", null, b)), /*#__PURE__*/React.createElement(__ds_scope.Toggle, {
    checked: on,
    onChange: onChange,
    label: "Still",
    variant: on ? 'on-blue' : 'default'
  }));
}
Object.assign(__ds_scope, { HeroCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/HeroCard.jsx", error: String((e && e.message) || e) }); }

// components/layout/SettingsCard.jsx
try { (() => {
function SettingsCard({
  variant = 'stack',
  label,
  title,
  sub,
  checked,
  onChange,
  action,
  children
}) {
  if (variant === 'row') {
    return /*#__PURE__*/React.createElement("section", {
      className: "card setting-row"
    }, /*#__PURE__*/React.createElement("div", {
      className: "row-text"
    }, /*#__PURE__*/React.createElement("span", {
      className: "row-title"
    }, title), sub && /*#__PURE__*/React.createElement("span", {
      className: "row-sub"
    }, sub)), /*#__PURE__*/React.createElement(__ds_scope.Toggle, {
      checked: checked,
      onChange: onChange,
      label: title
    }));
  }
  if (variant === 'sync-row') {
    return /*#__PURE__*/React.createElement("section", {
      className: "card card-stack"
    }, /*#__PURE__*/React.createElement("div", {
      className: "sync-row"
    }, /*#__PURE__*/React.createElement("div", {
      className: "sync-row-text"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "sync-row-title"
    }, title), sub && /*#__PURE__*/React.createElement("p", {
      className: "muted sync-row-sub"
    }, sub)), action), children);
  }
  return /*#__PURE__*/React.createElement("section", {
    className: "card card-stack"
  }, label && /*#__PURE__*/React.createElement("h2", {
    className: "section-label"
  }, label), children);
}
function AccountLinks({
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "account"
  }, children);
}
Object.assign(__ds_scope, { SettingsCard, AccountLinks });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/SettingsCard.jsx", error: String((e && e.message) || e) }); }

// components/layout/serviceIconData.js
try { (() => {
// Generated from assets/services/*.svg; inlined so nothing is fetched (as in ServiceIcon.svelte).
const serviceIconSrc = {
  "youtube": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCIgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiB4bWxuczpjMnBhPSJodHRwOi8vYzJwYS5vcmcvbWFuaWZlc3QiPjxtZXRhZGF0YT48YzJwYTptYW5pZmVzdD5BQUFXZ21wMWJXSUFBQUFlYW5WdFpHTXljR0VBRVFBUWdBQUFxZ0E0bTNFRFl6SndZUUFBQUJaY2FuVnRZZ0FBQUVkcWRXMWtZekp0WVFBUkFCQ0FBQUNxQURpYmNRTjFjbTQ2WXpKd1lUbzJZemc0WmpWbU15MHdOV0ZoTFRRM05Ea3RPV1l6WmkweE16WTFaVE14TmpWa05EZ0FBQUFEbDJwMWJXSUFBQUFwYW5WdFpHTXlZWE1BRVFBUWdBQUFxZ0E0bTNFRFl6SndZUzVoYzNObGNuUnBiMjV6QUFBQUFMeHFkVzFpQUFBQVJHcDFiV1JqWW05eUFCRUFFSUFBQUtvQU9KdHhFMk15Y0dFdWFXNW5jbVZrYVdWdWRDNTJNd0FBQUFBWVl6SnphRlQ4V1RhTGttWkVNSHlLUHN6dmFMNEFBQUJ3WTJKdmNxTnBaR002Wm05eWJXRjBiV2x0WVdkbEwzTjJaeXQ0Yld4cWFXNXpkR0Z1WTJWSlJIZ3NlRzF3T21scFpEcGlaalkyTlRka09DMWlNR0V6TFRRMU1USXRZak14WkMwME9UVmpaV1V5WVRJMU16VnNjbVZzWVhScGIyNXphR2x3YUhCaGNtVnVkRTltQUFBQjRtcDFiV0lBQUFCQmFuVnRaR05pYjNJQUVRQVFnQUFBcWdBNG0zRVRZekp3WVM1aFkzUnBiMjV6TG5ZeUFBQUFBQmhqTW5Ob0x5UStJcjRkL25FVUdqUUJ0T2IzaEFBQUFabGpZbTl5b21kaFkzUnBiMjV6Z3FKbVlXTjBhVzl1YTJNeWNHRXViM0JsYm1Wa2FuQmhjbUZ0WlhSbGNuT2hhMmx1WjNKbFpHbGxiblJ6Z2FKamRYSnNlQzF6Wld4bUkycDFiV0ptUFdNeWNHRXVZWE56WlhKMGFXOXVjeTlqTW5CaExtbHVaM0psWkdsbGJuUXVkak5rYUdGemFGZ2dXNFBVeVNVZG9rUDN3SEp3eUxxK3RRcEZxbklaYmgzMXByQVlRRmZmWEora1ptRmpkR2x2Ym5nZFkyOXRMbUZ1ZEdoeWIzQnBZeTVqYkdGMVpHVXVjSEp2ZG1sa1pXUnFjR0Z5WVcxbGRHVnljNkY0SDJOdmJTNWhiblJvY205d2FXTXViM0pwWjJsdUxXTnZibVpwWkdWdVkyVm5kVzVyYm05M2JtdGtaWE5qY21sd2RHbHZibmhtUTJ4aGRXUmxJSEJ5YjNacFpHVmtJSFJvYVhNZ1ptbHNaU0JoZENCMGFHVWdjbVZ4ZFdWemRDQnZaaUJoSUhWelpYSWdZVzVrSUcxaGVTQm9ZWFpsSUdOeVpXRjBaV1FnYjNJZ2JXOWthV1pwWldRZ2RHaGxJR1pwYkdVZ1kyOXVkR1Z1ZEhNdWJYTnZablIzWVhKbFFXZGxiblNoWkc1aGJXVm1RMnhoZFdSbGNtRnNiRUZqZEdsdmJuTkpibU5zZFdSbFpQVUFBQURJYW5WdFlnQUFBRUJxZFcxa1kySnZjZ0FSQUJDQUFBQ3FBRGliY1JOak1uQmhMbWhoYzJndVpHRjBZUUFBQUFBWVl6SnphSjBSN296NzBneVFrNXZGWTN5M0dLUUFBQUNBWTJKdmNxVmpZV3huWm5Ob1lUSTFObU53WVdSTkFBQUFBQUFBQUFBQUFBQUFBR1JvWVhOb1dDQm1GeStKVWg5MmUvTEdwR1hXaEpoWFJxTlJBMVZGTmZmQ015SVlyM0cycVdSdVlXMWxibXAxYldKbUlHMWhibWxtWlhOMGFtVjRZMngxYzJsdmJuT0JvbVZ6ZEdGeWRCaVNabXhsYm1kMGFCa2VCQUFBQWo1cWRXMWlBQUFBSjJwMWJXUmpNbU5zQUJFQUVJQUFBS29BT0p0eEEyTXljR0V1WTJ4aGFXMHVkaklBQUFBQ0QyTmliM0tsWTJGc1oyWnphR0V5TlRacGMybG5ibUYwZFhKbGVFMXpaV3htSTJwMWJXSm1QUzlqTW5CaEwzVnlianBqTW5CaE9qWmpPRGhtTldZekxUQTFZV0V0TkRjME9TMDVaak5tTFRFek5qVmxNekUyTldRME9DOWpNbkJoTG5OcFoyNWhkSFZ5WldwcGJuTjBZVzVqWlVsRWVDeDRiWEE2YVdsa09tRXlOV1JsTURCakxUaGtPRGN0TkdZeFlpMDVaRE01TFRNM05qYzFObVV3WlRrNU1YSmpjbVZoZEdWa1gyRnpjMlZ5ZEdsdmJuT0RvbU4xY214NExYTmxiR1lqYW5WdFltWTlZekp3WVM1aGMzTmxjblJwYjI1ekwyTXljR0V1YVc1bmNtVmthV1Z1ZEM1Mk0yUm9ZWE5vV0NCYmc5VEpKUjJpUS9mQWNuREl1cjYxQ2tXcWNobHVIZldtc0JoQVY5OWNuNkpqZFhKc2VDcHpaV3htSTJwMWJXSm1QV015Y0dFdVlYTnpaWEowYVc5dWN5OWpNbkJoTG1GamRHbHZibk11ZGpKa2FHRnphRmdnTGE3V1psYzRGV2pSbERmRkZZc1A3VHUvWnkzMmFxSEVEYXNhMlBoeXNsMmlZM1Z5YkhncGMyVnNaaU5xZFcxaVpqMWpNbkJoTG1GemMyVnlkR2x2Ym5Ndll6SndZUzVvWVhOb0xtUmhkR0ZrYUdGemFGZ2czc1d0am5LTFN1bEZvNGFraU1UU2Y3cU01MGhnVDhlYmFEajVBQkxTYW9aMFkyeGhhVzFmWjJWdVpYSmhkRzl5WDJsdVptK2paRzVoYldWdlFXNTBhSEp2Y0dsaklFWnBiR1Z6WjNabGNuTnBiMjVsTVM0d0xqQnJjM0JsWTFabGNuTnBiMjVsTWk0MExqQUFBQkE0YW5WdFlnQUFBQ2hxZFcxa1l6Smpjd0FSQUJDQUFBQ3FBRGliY1FOak1uQmhMbk5wWjI1aGRIVnlaUUFBQUJBSVkySnZjdEtFV1FJU29nRW1HQ0ZaQWdvd2dnSUdNSUlCamFBREFnRUNBaFJBNWFBSzdzSTUwTDY0Zy9vR1FnVTlaMVVUQURBS0JnZ3Foa2pPUFFRREF6QkpNUmN3RlFZRFZRUUtFdzVCYm5Sb2NtOXdhV01zSUZCQ1F6RXVNQ3dHQTFVRUF4TWxRVzUwYUhKdmNHbGpJRU52Ym5SbGJuUWdRM0psWkdWdWRHbGhiSE1nVW05dmRDQkRRVEFlRncweU5qQTRNRGN4T0RRek5UWmFGdzB5T0RBNE1EWXhPVFF6TlRaYU1FUXhGekFWQmdOVkJBb1REa0Z1ZEdoeWIzQnBZeXdnVUVKRE1Ta3dKd1lEVlFRREV5QkJiblJvY205d2FXTWdRMnhoZFdSbElFTnZiblJsYm5RZ1UybG5ibWx1WnpCWk1CTUdCeXFHU000OUFnRUdDQ3FHU000OUF3RUhBMElBQkpoNkNtdkxVQmdGRk5VMHZVS2xPVnRFNmRqZDE3TDVTdXdYMExlbUZpc0JNM2RrZC8zY3lqeEZBM1FvNVM0NmZYMC9paFkwVlo3bWZiOUtGNzAzdDVPaldEQldNQTRHQTFVZER3RUIvd1FFQXdJSGdEQVZCZ05WSFNVRURqQU1CZ29yQmdFRUFZUG9YZ0lCTUF3R0ExVWRFd0VCL3dRQ01BQXdId1lEVlIwakJCZ3dGb0FVemxIaUJJRk9aRnNqK09QRXo1bytuTUhYWE1Jd0NnWUlLb1pJemowRUF3TURad0F3WkFJd01YTWRGSjRCZXRMTFZZN09SdUU5bm9xYmJBWk9abi9hQXJYeVR3RkFaZktyUHp4RjJ2UG9KTmYxK1VDZGcxWEdBakJ3WDF6ZDlXR3FZa3FtTDVTRnF3MVF5U2pyMXpKZnBKTTkrMXJkRHdTUExNT1BPakt1aVhqb1UvcFVVZUc5UndtaFkzQmhaRmtObmdBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFQWllRSXRlZ2RWdHZ1OU9oRnlIdW9KQWEwTWFXcmU1ZTBKS0x6a2JYY0kzUjhmU0ppQmk1Z3BGcTBqYnRVbnpZMGtkTlI5WkJubExZTnBpUkd2U2pkQlJzQzQ9PC9jMnBhOm1hbmlmZXN0PjwvbWV0YWRhdGE+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiByeD0iMTMiIGZpbGw9IiNGRjAwMzMiPjwvcmVjdD48cGF0aCBkPSJNMjAgMTYuNSBMMzMgMjQgTDIwIDMxLjUgWiIgZmlsbD0iI2ZmZiI+PC9wYXRoPjwvc3ZnPg==",
  "instagram": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCIgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiB4bWxuczpjMnBhPSJodHRwOi8vYzJwYS5vcmcvbWFuaWZlc3QiPjxtZXRhZGF0YT48YzJwYTptYW5pZmVzdD5BQUFXZ21wMWJXSUFBQUFlYW5WdFpHTXljR0VBRVFBUWdBQUFxZ0E0bTNFRFl6SndZUUFBQUJaY2FuVnRZZ0FBQUVkcWRXMWtZekp0WVFBUkFCQ0FBQUNxQURpYmNRTjFjbTQ2WXpKd1lUb3lOREE0TTJFeU1TMWpNalZqTFRSaE1tVXRPV1l5WWkwd1pESXpZekE1TWpJeE9XUUFBQUFEbDJwMWJXSUFBQUFwYW5WdFpHTXlZWE1BRVFBUWdBQUFxZ0E0bTNFRFl6SndZUzVoYzNObGNuUnBiMjV6QUFBQUFMeHFkVzFpQUFBQVJHcDFiV1JqWW05eUFCRUFFSUFBQUtvQU9KdHhFMk15Y0dFdWFXNW5jbVZrYVdWdWRDNTJNd0FBQUFBWVl6SnphSEV2T1ZvZFNPRzdpUDJqbStDVnI3Z0FBQUJ3WTJKdmNxTnBaR002Wm05eWJXRjBiV2x0WVdkbEwzTjJaeXQ0Yld4cWFXNXpkR0Z1WTJWSlJIZ3NlRzF3T21scFpEbzRZV05oTTJJMVpTMDNOR1prTFRRMk9ERXRZVEkxT1MweE9EZ3lNVE0wWmprd056aHNjbVZzWVhScGIyNXphR2x3YUhCaGNtVnVkRTltQUFBQjRtcDFiV0lBQUFCQmFuVnRaR05pYjNJQUVRQVFnQUFBcWdBNG0zRVRZekp3WVM1aFkzUnBiMjV6TG5ZeUFBQUFBQmhqTW5Ob3FmeWowMXRpYXVobDNqeFlLaWNiWkFBQUFabGpZbTl5b21kaFkzUnBiMjV6Z3FKbVlXTjBhVzl1YTJNeWNHRXViM0JsYm1Wa2FuQmhjbUZ0WlhSbGNuT2hhMmx1WjNKbFpHbGxiblJ6Z2FKamRYSnNlQzF6Wld4bUkycDFiV0ptUFdNeWNHRXVZWE56WlhKMGFXOXVjeTlqTW5CaExtbHVaM0psWkdsbGJuUXVkak5rYUdGemFGZ2d0azB5dkR0dXhhelVhK0FoRW9YWjJjYkRKTkJiNS9KUTF3YzdNS0N5L2o2a1ptRmpkR2x2Ym5nZFkyOXRMbUZ1ZEdoeWIzQnBZeTVqYkdGMVpHVXVjSEp2ZG1sa1pXUnFjR0Z5WVcxbGRHVnljNkY0SDJOdmJTNWhiblJvY205d2FXTXViM0pwWjJsdUxXTnZibVpwWkdWdVkyVm5kVzVyYm05M2JtdGtaWE5qY21sd2RHbHZibmhtUTJ4aGRXUmxJSEJ5YjNacFpHVmtJSFJvYVhNZ1ptbHNaU0JoZENCMGFHVWdjbVZ4ZFdWemRDQnZaaUJoSUhWelpYSWdZVzVrSUcxaGVTQm9ZWFpsSUdOeVpXRjBaV1FnYjNJZ2JXOWthV1pwWldRZ2RHaGxJR1pwYkdVZ1kyOXVkR1Z1ZEhNdWJYTnZablIzWVhKbFFXZGxiblNoWkc1aGJXVm1RMnhoZFdSbGNtRnNiRUZqZEdsdmJuTkpibU5zZFdSbFpQVUFBQURJYW5WdFlnQUFBRUJxZFcxa1kySnZjZ0FSQUJDQUFBQ3FBRGliY1JOak1uQmhMbWhoYzJndVpHRjBZUUFBQUFBWVl6SnphRHpCUm9jMjlEb3h3c2tuNE5uTUozRUFBQUNBWTJKdmNxVmpZV3huWm5Ob1lUSTFObU53WVdSTkFBQUFBQUFBQUFBQUFBQUFBR1JvWVhOb1dDQ3JHaGkzaUZJUlF1ZWN6QWxjYVZybGZvTXlTT1B0NDdWTUdUU2NrSzlrNDJSdVlXMWxibXAxYldKbUlHMWhibWxtWlhOMGFtVjRZMngxYzJsdmJuT0JvbVZ6ZEdGeWRCaVNabXhsYm1kMGFCa2VCQUFBQWo1cWRXMWlBQUFBSjJwMWJXUmpNbU5zQUJFQUVJQUFBS29BT0p0eEEyTXljR0V1WTJ4aGFXMHVkaklBQUFBQ0QyTmliM0tsWTJGc1oyWnphR0V5TlRacGMybG5ibUYwZFhKbGVFMXpaV3htSTJwMWJXSm1QUzlqTW5CaEwzVnlianBqTW5CaE9qSTBNRGd6WVRJeExXTXlOV010TkdFeVpTMDVaakppTFRCa01qTmpNRGt5TWpFNVpDOWpNbkJoTG5OcFoyNWhkSFZ5WldwcGJuTjBZVzVqWlVsRWVDeDRiWEE2YVdsa09qQXdObVE0TW1ReExXUTVNREF0TkRaaFpTMWhOVFk0TFRVMU5ERTVOVEpqWVRSbE1ISmpjbVZoZEdWa1gyRnpjMlZ5ZEdsdmJuT0RvbU4xY214NExYTmxiR1lqYW5WdFltWTlZekp3WVM1aGMzTmxjblJwYjI1ekwyTXljR0V1YVc1bmNtVmthV1Z1ZEM1Mk0yUm9ZWE5vV0NDMlRUSzhPMjdGck5ScjRDRVNoZG5aeHNNazBGdm44bERYQnpzd29MTCtQcUpqZFhKc2VDcHpaV3htSTJwMWJXSm1QV015Y0dFdVlYTnpaWEowYVc5dWN5OWpNbkJoTG1GamRHbHZibk11ZGpKa2FHRnphRmdnTWgxUWtKZHZhK2pzSHh3a3RXUzB2TXRPSS8wcDNIdWh5RkRxcGF0czlWNmlZM1Z5YkhncGMyVnNaaU5xZFcxaVpqMWpNbkJoTG1GemMyVnlkR2x2Ym5Ndll6SndZUzVvWVhOb0xtUmhkR0ZrYUdGemFGZ2d6bXJMQlVYZVdjYjA4T2F1MEcwVkphZkVKNVBrN0Q1MEdMMVptbTdxQXpOMFkyeGhhVzFmWjJWdVpYSmhkRzl5WDJsdVptK2paRzVoYldWdlFXNTBhSEp2Y0dsaklFWnBiR1Z6WjNabGNuTnBiMjVsTVM0d0xqQnJjM0JsWTFabGNuTnBiMjVsTWk0MExqQUFBQkE0YW5WdFlnQUFBQ2hxZFcxa1l6Smpjd0FSQUJDQUFBQ3FBRGliY1FOak1uQmhMbk5wWjI1aGRIVnlaUUFBQUJBSVkySnZjdEtFV1FJU29nRW1HQ0ZaQWdvd2dnSUdNSUlCamFBREFnRUNBaFJBNWFBSzdzSTUwTDY0Zy9vR1FnVTlaMVVUQURBS0JnZ3Foa2pPUFFRREF6QkpNUmN3RlFZRFZRUUtFdzVCYm5Sb2NtOXdhV01zSUZCQ1F6RXVNQ3dHQTFVRUF4TWxRVzUwYUhKdmNHbGpJRU52Ym5SbGJuUWdRM0psWkdWdWRHbGhiSE1nVW05dmRDQkRRVEFlRncweU5qQTRNRGN4T0RRek5UWmFGdzB5T0RBNE1EWXhPVFF6TlRaYU1FUXhGekFWQmdOVkJBb1REa0Z1ZEdoeWIzQnBZeXdnVUVKRE1Ta3dKd1lEVlFRREV5QkJiblJvY205d2FXTWdRMnhoZFdSbElFTnZiblJsYm5RZ1UybG5ibWx1WnpCWk1CTUdCeXFHU000OUFnRUdDQ3FHU000OUF3RUhBMElBQkpoNkNtdkxVQmdGRk5VMHZVS2xPVnRFNmRqZDE3TDVTdXdYMExlbUZpc0JNM2RrZC8zY3lqeEZBM1FvNVM0NmZYMC9paFkwVlo3bWZiOUtGNzAzdDVPaldEQldNQTRHQTFVZER3RUIvd1FFQXdJSGdEQVZCZ05WSFNVRURqQU1CZ29yQmdFRUFZUG9YZ0lCTUF3R0ExVWRFd0VCL3dRQ01BQXdId1lEVlIwakJCZ3dGb0FVemxIaUJJRk9aRnNqK09QRXo1bytuTUhYWE1Jd0NnWUlLb1pJemowRUF3TURad0F3WkFJd01YTWRGSjRCZXRMTFZZN09SdUU5bm9xYmJBWk9abi9hQXJYeVR3RkFaZktyUHp4RjJ2UG9KTmYxK1VDZGcxWEdBakJ3WDF6ZDlXR3FZa3FtTDVTRnF3MVF5U2pyMXpKZnBKTTkrMXJkRHdTUExNT1BPakt1aVhqb1UvcFVVZUc5UndtaFkzQmhaRmtObmdBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFQWllRQjEwYk9xR3E0NERjb3lSS2djUEozRUU5YjBLVUJwdk5OUStJZmszRmQxTE9yU1ErSUFudVRsMjJQSFJvNjl2em90MVBuanNpVER3cUZhbElTZ2xOVm89PC9jMnBhOm1hbmlmZXN0PjwvbWV0YWRhdGE+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJpZy1ncmFkIiB4MT0iMCIgeTE9IjEiIHgyPSIxIiB5Mj0iMCI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjRkZENzc2Ij48L3N0b3A+PHN0b3Agb2Zmc2V0PSIwLjI4IiBzdG9wLWNvbG9yPSIjRjU4NTI5Ij48L3N0b3A+PHN0b3Agb2Zmc2V0PSIwLjYyIiBzdG9wLWNvbG9yPSIjREQyQTdCIj48L3N0b3A+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjODEzNEFGIj48L3N0b3A+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiByeD0iMTMiIGZpbGw9InVybCgjaWctZ3JhZCkiPjwvcmVjdD48cmVjdCB4PSIxMy41IiB5PSIxMy41IiB3aWR0aD0iMjEiIGhlaWdodD0iMjEiIHJ4PSI2LjUiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIyLjYiPjwvcmVjdD48Y2lyY2xlIGN4PSIyNCIgY3k9IjI0IiByPSI1LjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIyLjYiPjwvY2lyY2xlPjxjaXJjbGUgY3g9IjMwLjYiIGN5PSIxNy40IiByPSIxLjciIGZpbGw9IiNmZmYiPjwvY2lyY2xlPjwvc3ZnPg==",
  "tiktok": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCIgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiB4bWxuczpjMnBhPSJodHRwOi8vYzJwYS5vcmcvbWFuaWZlc3QiPjxtZXRhZGF0YT48YzJwYTptYW5pZmVzdD5BQUFXZ21wMWJXSUFBQUFlYW5WdFpHTXljR0VBRVFBUWdBQUFxZ0E0bTNFRFl6SndZUUFBQUJaY2FuVnRZZ0FBQUVkcWRXMWtZekp0WVFBUkFCQ0FBQUNxQURpYmNRTjFjbTQ2WXpKd1lUb3laVGcyTTJSaVl5MHhOVEU1TFRSaU9Ua3RZVEV3TmkweE5HWTNaREkyTm1KaVpHSUFBQUFEbDJwMWJXSUFBQUFwYW5WdFpHTXlZWE1BRVFBUWdBQUFxZ0E0bTNFRFl6SndZUzVoYzNObGNuUnBiMjV6QUFBQUFMeHFkVzFpQUFBQVJHcDFiV1JqWW05eUFCRUFFSUFBQUtvQU9KdHhFMk15Y0dFdWFXNW5jbVZrYVdWdWRDNTJNd0FBQUFBWVl6SnphTEtkdE50bHJTckVkN0gyZnlXQ00zd0FBQUJ3WTJKdmNxTnBaR002Wm05eWJXRjBiV2x0WVdkbEwzTjJaeXQ0Yld4cWFXNXpkR0Z1WTJWSlJIZ3NlRzF3T21scFpEcGtNalExWldFNFlpMWlOekZqTFRSaFlqWXRZVGN6TnkxaFpEZzRaR1kxWmpGbVpXVnNjbVZzWVhScGIyNXphR2x3YUhCaGNtVnVkRTltQUFBQjRtcDFiV0lBQUFCQmFuVnRaR05pYjNJQUVRQVFnQUFBcWdBNG0zRVRZekp3WVM1aFkzUnBiMjV6TG5ZeUFBQUFBQmhqTW5Ob3RpTGVvdnh2UUdlNG5NWUtFVjN4MXdBQUFabGpZbTl5b21kaFkzUnBiMjV6Z3FKbVlXTjBhVzl1YTJNeWNHRXViM0JsYm1Wa2FuQmhjbUZ0WlhSbGNuT2hhMmx1WjNKbFpHbGxiblJ6Z2FKamRYSnNlQzF6Wld4bUkycDFiV0ptUFdNeWNHRXVZWE56WlhKMGFXOXVjeTlqTW5CaExtbHVaM0psWkdsbGJuUXVkak5rYUdGemFGZ2dSam1lb2RRUnZFaEVobUpnZVZ3aVExNjZCQzZQcnlrUmFORzM0VlhNY05ha1ptRmpkR2x2Ym5nZFkyOXRMbUZ1ZEdoeWIzQnBZeTVqYkdGMVpHVXVjSEp2ZG1sa1pXUnFjR0Z5WVcxbGRHVnljNkY0SDJOdmJTNWhiblJvY205d2FXTXViM0pwWjJsdUxXTnZibVpwWkdWdVkyVm5kVzVyYm05M2JtdGtaWE5qY21sd2RHbHZibmhtUTJ4aGRXUmxJSEJ5YjNacFpHVmtJSFJvYVhNZ1ptbHNaU0JoZENCMGFHVWdjbVZ4ZFdWemRDQnZaaUJoSUhWelpYSWdZVzVrSUcxaGVTQm9ZWFpsSUdOeVpXRjBaV1FnYjNJZ2JXOWthV1pwWldRZ2RHaGxJR1pwYkdVZ1kyOXVkR1Z1ZEhNdWJYTnZablIzWVhKbFFXZGxiblNoWkc1aGJXVm1RMnhoZFdSbGNtRnNiRUZqZEdsdmJuTkpibU5zZFdSbFpQVUFBQURJYW5WdFlnQUFBRUJxZFcxa1kySnZjZ0FSQUJDQUFBQ3FBRGliY1JOak1uQmhMbWhoYzJndVpHRjBZUUFBQUFBWVl6SnphSmxnYVdIakE1U0FMMkhoMCtsMnNwNEFBQUNBWTJKdmNxVmpZV3huWm5Ob1lUSTFObU53WVdSTkFBQUFBQUFBQUFBQUFBQUFBR1JvWVhOb1dDQkI1NkFDS25CNkt4aTY0MHJKZmJxaTV1S3dUVHV4RCt1UlMvYnZWNEVzSkdSdVlXMWxibXAxYldKbUlHMWhibWxtWlhOMGFtVjRZMngxYzJsdmJuT0JvbVZ6ZEdGeWRCaVNabXhsYm1kMGFCa2VCQUFBQWo1cWRXMWlBQUFBSjJwMWJXUmpNbU5zQUJFQUVJQUFBS29BT0p0eEEyTXljR0V1WTJ4aGFXMHVkaklBQUFBQ0QyTmliM0tsWTJGc1oyWnphR0V5TlRacGMybG5ibUYwZFhKbGVFMXpaV3htSTJwMWJXSm1QUzlqTW5CaEwzVnlianBqTW5CaE9qSmxPRFl6WkdKakxURTFNVGt0TkdJNU9TMWhNVEEyTFRFMFpqZGtNalkyWW1Ka1lpOWpNbkJoTG5OcFoyNWhkSFZ5WldwcGJuTjBZVzVqWlVsRWVDeDRiWEE2YVdsa09qTTRObU5rWldNMkxXWmlNekF0TkdJMlpTMDVPVEUxTFdJMk1tSTRZbVpoTW1RMU5ISmpjbVZoZEdWa1gyRnpjMlZ5ZEdsdmJuT0RvbU4xY214NExYTmxiR1lqYW5WdFltWTlZekp3WVM1aGMzTmxjblJwYjI1ekwyTXljR0V1YVc1bmNtVmthV1Z1ZEM1Mk0yUm9ZWE5vV0NCR09aNmgxQkc4U0VTR1ltQjVYQ0pEWHJvRUxvK3ZLUkZvMGJmaFZjeHcxcUpqZFhKc2VDcHpaV3htSTJwMWJXSm1QV015Y0dFdVlYTnpaWEowYVc5dWN5OWpNbkJoTG1GamRHbHZibk11ZGpKa2FHRnphRmdncjlHSzZlRTRCbmxFQXkwbDVXRzBJSTg2ZU1VNkRIdlhORXhmLzFtaWE2U2lZM1Z5YkhncGMyVnNaaU5xZFcxaVpqMWpNbkJoTG1GemMyVnlkR2x2Ym5Ndll6SndZUzVvWVhOb0xtUmhkR0ZrYUdGemFGZ2dLR2VNeDlqbk5sd21RZnhUcTE5blR2QTZabGxSWVVkWUxibzVTY2JpbWZCMFkyeGhhVzFmWjJWdVpYSmhkRzl5WDJsdVptK2paRzVoYldWdlFXNTBhSEp2Y0dsaklFWnBiR1Z6WjNabGNuTnBiMjVsTVM0d0xqQnJjM0JsWTFabGNuTnBiMjVsTWk0MExqQUFBQkE0YW5WdFlnQUFBQ2hxZFcxa1l6Smpjd0FSQUJDQUFBQ3FBRGliY1FOak1uQmhMbk5wWjI1aGRIVnlaUUFBQUJBSVkySnZjdEtFV1FJU29nRW1HQ0ZaQWdvd2dnSUdNSUlCamFBREFnRUNBaFJBNWFBSzdzSTUwTDY0Zy9vR1FnVTlaMVVUQURBS0JnZ3Foa2pPUFFRREF6QkpNUmN3RlFZRFZRUUtFdzVCYm5Sb2NtOXdhV01zSUZCQ1F6RXVNQ3dHQTFVRUF4TWxRVzUwYUhKdmNHbGpJRU52Ym5SbGJuUWdRM0psWkdWdWRHbGhiSE1nVW05dmRDQkRRVEFlRncweU5qQTRNRGN4T0RRek5UWmFGdzB5T0RBNE1EWXhPVFF6TlRaYU1FUXhGekFWQmdOVkJBb1REa0Z1ZEdoeWIzQnBZeXdnVUVKRE1Ta3dKd1lEVlFRREV5QkJiblJvY205d2FXTWdRMnhoZFdSbElFTnZiblJsYm5RZ1UybG5ibWx1WnpCWk1CTUdCeXFHU000OUFnRUdDQ3FHU000OUF3RUhBMElBQkpoNkNtdkxVQmdGRk5VMHZVS2xPVnRFNmRqZDE3TDVTdXdYMExlbUZpc0JNM2RrZC8zY3lqeEZBM1FvNVM0NmZYMC9paFkwVlo3bWZiOUtGNzAzdDVPaldEQldNQTRHQTFVZER3RUIvd1FFQXdJSGdEQVZCZ05WSFNVRURqQU1CZ29yQmdFRUFZUG9YZ0lCTUF3R0ExVWRFd0VCL3dRQ01BQXdId1lEVlIwakJCZ3dGb0FVemxIaUJJRk9aRnNqK09QRXo1bytuTUhYWE1Jd0NnWUlLb1pJemowRUF3TURad0F3WkFJd01YTWRGSjRCZXRMTFZZN09SdUU5bm9xYmJBWk9abi9hQXJYeVR3RkFaZktyUHp4RjJ2UG9KTmYxK1VDZGcxWEdBakJ3WDF6ZDlXR3FZa3FtTDVTRnF3MVF5U2pyMXpKZnBKTTkrMXJkRHdTUExNT1BPakt1aVhqb1UvcFVVZUc5UndtaFkzQmhaRmtObmdBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFQWllRSFU5WHRhY3hlUGJWNmd5YlZWMnpMaW9GOUhhbi9sUmZqUDExeXBMcHk2a0ErcDgreUIrajZnRmFUTjl5ZUNKcXgybFErQkE3NGVLVnNTVkd3Z1VlZ0k9PC9jMnBhOm1hbmlmZXN0PjwvbWV0YWRhdGE+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiByeD0iMTMiIGZpbGw9IiMwMDAiPjwvcmVjdD48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxLjQsLTEuMSkiIGZpbGw9IiMyNUY0RUUiPjxwYXRoIGQ9Ik0yNyAxNGgzLjRjLjQgMy4xIDIuNiA1LjQgNS42IDUuN3YzLjVjLTEuOCAwLTMuNS0uNS01LTEuNHY2LjlhNy42IDcuNiAwIDEgMS03LjYtNy42Yy40IDAgLjggMCAxLjIuMXYzLjdhNCA0IDAgMSAwIDIuOCAzLjhWMTR6Ij48L3BhdGg+PC9nPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKC0xLjQsMS4xKSIgZmlsbD0iI0ZFMkM1NSI+PHBhdGggZD0iTTI3IDE0aDMuNGMuNCAzLjEgMi42IDUuNCA1LjYgNS43djMuNWMtMS44IDAtMy41LS41LTUtMS40djYuOWE3LjYgNy42IDAgMSAxLTcuNi03LjZjLjQgMCAuOCAwIDEuMi4xdjMuN2E0IDQgMCAxIDAgMi44IDMuOFYxNHoiPjwvcGF0aD48L2c+PHBhdGggZD0iTTI3IDE0aDMuNGMuNCAzLjEgMi42IDUuNCA1LjYgNS43djMuNWMtMS44IDAtMy41LS41LTUtMS40djYuOWE3LjYgNy42IDAgMSAxLTcuNi03LjZjLjQgMCAuOCAwIDEuMi4xdjMuN2E0IDQgMCAxIDAgMi44IDMuOFYxNHoiIGZpbGw9IiNmZmYiPjwvcGF0aD48L3N2Zz4=",
  "facebook": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCIgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiB4bWxuczpjMnBhPSJodHRwOi8vYzJwYS5vcmcvbWFuaWZlc3QiPjxtZXRhZGF0YT48YzJwYTptYW5pZmVzdD5BQUFXZ21wMWJXSUFBQUFlYW5WdFpHTXljR0VBRVFBUWdBQUFxZ0E0bTNFRFl6SndZUUFBQUJaY2FuVnRZZ0FBQUVkcWRXMWtZekp0WVFBUkFCQ0FBQUNxQURpYmNRTjFjbTQ2WXpKd1lUcGlNekkwTVRBeFppMDVNbU0xTFRSbE5tSXRZbUV6T0MwMVkyWTRaamN5TXpWaU5qUUFBQUFEbDJwMWJXSUFBQUFwYW5WdFpHTXlZWE1BRVFBUWdBQUFxZ0E0bTNFRFl6SndZUzVoYzNObGNuUnBiMjV6QUFBQUFMeHFkVzFpQUFBQVJHcDFiV1JqWW05eUFCRUFFSUFBQUtvQU9KdHhFMk15Y0dFdWFXNW5jbVZrYVdWdWRDNTJNd0FBQUFBWVl6SnphRG16U1psdjBFRFdCbzd2WTJKbjMyZ0FBQUJ3WTJKdmNxTnBaR002Wm05eWJXRjBiV2x0WVdkbEwzTjJaeXQ0Yld4cWFXNXpkR0Z1WTJWSlJIZ3NlRzF3T21scFpEbzFaR1V6WVdJell5MDBaRGhtTFRRM1pqSXRZamc1WkMweFpqYzJNekl3WVdFMU9HSnNjbVZzWVhScGIyNXphR2x3YUhCaGNtVnVkRTltQUFBQjRtcDFiV0lBQUFCQmFuVnRaR05pYjNJQUVRQVFnQUFBcWdBNG0zRVRZekp3WVM1aFkzUnBiMjV6TG5ZeUFBQUFBQmhqTW5Ob2ZhMVNNL2FJRk82L2RONlRUNmdtcHdBQUFabGpZbTl5b21kaFkzUnBiMjV6Z3FKbVlXTjBhVzl1YTJNeWNHRXViM0JsYm1Wa2FuQmhjbUZ0WlhSbGNuT2hhMmx1WjNKbFpHbGxiblJ6Z2FKamRYSnNlQzF6Wld4bUkycDFiV0ptUFdNeWNHRXVZWE56WlhKMGFXOXVjeTlqTW5CaExtbHVaM0psWkdsbGJuUXVkak5rYUdGemFGZ2dlaHkwVlAxb0xlam5maG1HNTFxUnZ1L3FFTkRSQ0IyMFYvL0ZpeXRCOTVXa1ptRmpkR2x2Ym5nZFkyOXRMbUZ1ZEdoeWIzQnBZeTVqYkdGMVpHVXVjSEp2ZG1sa1pXUnFjR0Z5WVcxbGRHVnljNkY0SDJOdmJTNWhiblJvY205d2FXTXViM0pwWjJsdUxXTnZibVpwWkdWdVkyVm5kVzVyYm05M2JtdGtaWE5qY21sd2RHbHZibmhtUTJ4aGRXUmxJSEJ5YjNacFpHVmtJSFJvYVhNZ1ptbHNaU0JoZENCMGFHVWdjbVZ4ZFdWemRDQnZaaUJoSUhWelpYSWdZVzVrSUcxaGVTQm9ZWFpsSUdOeVpXRjBaV1FnYjNJZ2JXOWthV1pwWldRZ2RHaGxJR1pwYkdVZ1kyOXVkR1Z1ZEhNdWJYTnZablIzWVhKbFFXZGxiblNoWkc1aGJXVm1RMnhoZFdSbGNtRnNiRUZqZEdsdmJuTkpibU5zZFdSbFpQVUFBQURJYW5WdFlnQUFBRUJxZFcxa1kySnZjZ0FSQUJDQUFBQ3FBRGliY1JOak1uQmhMbWhoYzJndVpHRjBZUUFBQUFBWVl6SnphQnNYQ2o3UEFWckVpL0xUa3AvQlRha0FBQUNBWTJKdmNxVmpZV3huWm5Ob1lUSTFObU53WVdSTkFBQUFBQUFBQUFBQUFBQUFBR1JvWVhOb1dDQmJJck8zbFc5eURzOWNWbTJ2RGpWYTlZSmdkUXJXRDRncmpJcVZnem1wZjJSdVlXMWxibXAxYldKbUlHMWhibWxtWlhOMGFtVjRZMngxYzJsdmJuT0JvbVZ6ZEdGeWRCaVNabXhsYm1kMGFCa2VCQUFBQWo1cWRXMWlBQUFBSjJwMWJXUmpNbU5zQUJFQUVJQUFBS29BT0p0eEEyTXljR0V1WTJ4aGFXMHVkaklBQUFBQ0QyTmliM0tsWTJGc1oyWnphR0V5TlRacGMybG5ibUYwZFhKbGVFMXpaV3htSTJwMWJXSm1QUzlqTW5CaEwzVnlianBqTW5CaE9tSXpNalF4TURGbUxUa3lZelV0TkdVMllpMWlZVE00TFRWalpqaG1Oekl6TldJMk5DOWpNbkJoTG5OcFoyNWhkSFZ5WldwcGJuTjBZVzVqWlVsRWVDeDRiWEE2YVdsa09qTTFOakF3TURVd0xXWXpZV0V0TkdaaFlTMWhaakptTFRNNFlUUTVNVE5rTURGaVpYSmpjbVZoZEdWa1gyRnpjMlZ5ZEdsdmJuT0RvbU4xY214NExYTmxiR1lqYW5WdFltWTlZekp3WVM1aGMzTmxjblJwYjI1ekwyTXljR0V1YVc1bmNtVmthV1Z1ZEM1Mk0yUm9ZWE5vV0NCNkhMUlUvV2d0Nk9kK0dZYm5XcEcrNytvUTBORUlIYlJYLzhXTEswSDNsYUpqZFhKc2VDcHpaV3htSTJwMWJXSm1QV015Y0dFdVlYTnpaWEowYVc5dWN5OWpNbkJoTG1GamRHbHZibk11ZGpKa2FHRnphRmdnaHgrS2sva3U4RFdBUlVkNjQ2Vnltdm9xd1YxTzJEWHliMEhSeUc4ZkdaR2lZM1Z5YkhncGMyVnNaaU5xZFcxaVpqMWpNbkJoTG1GemMyVnlkR2x2Ym5Ndll6SndZUzVvWVhOb0xtUmhkR0ZrYUdGemFGZ2c0ZEFmSC9QeHBBY3d1UGpOZjFLcU1yYzFWOWdzd21zZGJPR0pPY2xyQURoMFkyeGhhVzFmWjJWdVpYSmhkRzl5WDJsdVptK2paRzVoYldWdlFXNTBhSEp2Y0dsaklFWnBiR1Z6WjNabGNuTnBiMjVsTVM0d0xqQnJjM0JsWTFabGNuTnBiMjVsTWk0MExqQUFBQkE0YW5WdFlnQUFBQ2hxZFcxa1l6Smpjd0FSQUJDQUFBQ3FBRGliY1FOak1uQmhMbk5wWjI1aGRIVnlaUUFBQUJBSVkySnZjdEtFV1FJU29nRW1HQ0ZaQWdvd2dnSUdNSUlCamFBREFnRUNBaFJBNWFBSzdzSTUwTDY0Zy9vR1FnVTlaMVVUQURBS0JnZ3Foa2pPUFFRREF6QkpNUmN3RlFZRFZRUUtFdzVCYm5Sb2NtOXdhV01zSUZCQ1F6RXVNQ3dHQTFVRUF4TWxRVzUwYUhKdmNHbGpJRU52Ym5SbGJuUWdRM0psWkdWdWRHbGhiSE1nVW05dmRDQkRRVEFlRncweU5qQTRNRGN4T0RRek5UWmFGdzB5T0RBNE1EWXhPVFF6TlRaYU1FUXhGekFWQmdOVkJBb1REa0Z1ZEdoeWIzQnBZeXdnVUVKRE1Ta3dKd1lEVlFRREV5QkJiblJvY205d2FXTWdRMnhoZFdSbElFTnZiblJsYm5RZ1UybG5ibWx1WnpCWk1CTUdCeXFHU000OUFnRUdDQ3FHU000OUF3RUhBMElBQkpoNkNtdkxVQmdGRk5VMHZVS2xPVnRFNmRqZDE3TDVTdXdYMExlbUZpc0JNM2RrZC8zY3lqeEZBM1FvNVM0NmZYMC9paFkwVlo3bWZiOUtGNzAzdDVPaldEQldNQTRHQTFVZER3RUIvd1FFQXdJSGdEQVZCZ05WSFNVRURqQU1CZ29yQmdFRUFZUG9YZ0lCTUF3R0ExVWRFd0VCL3dRQ01BQXdId1lEVlIwakJCZ3dGb0FVemxIaUJJRk9aRnNqK09QRXo1bytuTUhYWE1Jd0NnWUlLb1pJemowRUF3TURad0F3WkFJd01YTWRGSjRCZXRMTFZZN09SdUU5bm9xYmJBWk9abi9hQXJYeVR3RkFaZktyUHp4RjJ2UG9KTmYxK1VDZGcxWEdBakJ3WDF6ZDlXR3FZa3FtTDVTRnF3MVF5U2pyMXpKZnBKTTkrMXJkRHdTUExNT1BPakt1aVhqb1UvcFVVZUc5UndtaFkzQmhaRmtObmdBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFQWllRS2ZzZ01tT1ZiNnp3VFdKVUhCTXEyMnZOc2QvZVZSdTZndHVEenNvRHVDS25TajdzMDZ1NGlvZUlOdWxxOHJqa016VmtmVlJLMGc5QXVaa2lSRUwrblk9PC9jMnBhOm1hbmlmZXN0PjwvbWV0YWRhdGE+PGNpcmNsZSBjeD0iMjQiIGN5PSIyNCIgcj0iMjQiIGZpbGw9IiMxODc3RjIiPjwvY2lyY2xlPjxwYXRoIGQ9Ik0yNy4zIDI1LjVsLjc0LTQuNzhoLTQuNTh2LTMuMWMwLTEuMzEuNjQtMi41OCAyLjctMi41OGgyLjA4di00LjA3cy0xLjg5LS4zMi0zLjctLjMyYy0zLjc3IDAtNi4yNCAyLjI5LTYuMjQgNi40M3YzLjY0aC00LjJ2NC43OGg0LjJ2MTEuNTZhMTYuNyAxNi43IDAgMCAwIDUuMTYgMFYyNS41eiIgZmlsbD0iI2ZmZiI+PC9wYXRoPjwvc3ZnPg=="
};
Object.assign(__ds_scope, { serviceIconSrc });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/serviceIconData.js", error: String((e && e.message) || e) }); }

// components/layout/ServiceIcon.jsx
try { (() => {
function ServiceIcon({
  service,
  size
}) {
  const st = size ? {
    inlineSize: size,
    blockSize: size,
    display: 'block',
    flex: 'none'
  } : {
    display: 'block',
    inlineSize: '100%',
    blockSize: '100%'
  };
  return /*#__PURE__*/React.createElement("img", {
    src: __ds_scope.serviceIconSrc[service],
    alt: "",
    style: st
  });
}
Object.assign(__ds_scope, { ServiceIcon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/ServiceIcon.jsx", error: String((e && e.message) || e) }); }

// components/layout/useModalFocus.js
try { (() => {
const {
  useEffect,
  useRef
} = React;
const SEL = 'button:not([disabled]),a[href],input:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Moves focus into a modal, traps Tab, closes on Escape, returns focus to the opener on close.
function useModalFocus(active, onDismiss) {
  const ref = useRef(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!active) return undefined;
    const opener = document.activeElement;
    const node = ref.current;
    const first = node && (node.querySelector('[data-autofocus]') || node.querySelector(SEL));
    if (first) first.focus({
      preventScroll: true
    });
    const onKey = e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (dismiss.current) dismiss.current();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const els = Array.from(node.querySelectorAll(SEL));
      if (!els.length) return;
      const a = els[0],
        z = els[els.length - 1];
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener && opener.focus) opener.focus({
        preventScroll: true
      });
    };
  }, [active]);
  return ref;
}
Object.assign(__ds_scope, { useModalFocus });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/useModalFocus.js", error: String((e && e.message) || e) }); }

// components/layout/Dialog.jsx
try { (() => {
function Dialog({
  open = true,
  title,
  body,
  confirmLabel,
  onConfirm,
  cancelLabel = 'Cancel',
  onCancel,
  tone = 'default',
  contained = false,
  trapFocus = true,
  children
}) {
  const ref = __ds_scope.useModalFocus(open && trapFocus, onCancel);
  if (!open) return null;
  const pos = contained ? {
    position: 'absolute'
  } : undefined;
  const id = 'dlg-' + (title || 'x').replace(/\W+/g, '-').toLowerCase();
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "scrim",
    style: pos,
    onClick: onCancel
  }), /*#__PURE__*/React.createElement("div", {
    ref: ref,
    className: "dialog",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": id + '-t',
    "aria-describedby": body ? id + '-b' : undefined,
    style: pos
  }, /*#__PURE__*/React.createElement("h2", {
    id: id + '-t'
  }, title), body && /*#__PURE__*/React.createElement("p", {
    className: "body",
    id: id + '-b'
  }, body), children, /*#__PURE__*/React.createElement("div", {
    className: "dialog-actions"
  }, confirmLabel && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: tone === 'danger' ? 'danger-solid' : 'primary',
    onClick: onConfirm
  }, confirmLabel), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "secondary",
    "data-autofocus": "",
    onClick: onCancel
  }, cancelLabel))));
}
Object.assign(__ds_scope, { Dialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/Dialog.jsx", error: String((e && e.message) || e) }); }

// components/blocked/TikTokBlocked.jsx
try { (() => {
const {
  useState
} = React;
function TikTokBlocked({
  host = 'browser',
  state = 'blocked',
  confirmOpen,
  onOpenOnce,
  onOpenSettings,
  onReload,
  contained = false,
  style
}) {
  const [inner, setInner] = useState(false);
  const open = confirmOpen ?? inner;
  const close = () => setInner(false);
  return /*#__PURE__*/React.createElement("main", {
    className: "still-ui blocked",
    style: {
      position: contained ? 'relative' : undefined,
      ...style
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Logo, {
    size: 44,
    markOnly: true
  }), /*#__PURE__*/React.createElement("h1", null, "TikTok stays closed."), state === 'reload' ? /*#__PURE__*/React.createElement("div", {
    className: "blocked-actions"
  }, /*#__PURE__*/React.createElement(__ds_scope.StatusLine, {
    tone: "info",
    announce: false
  }, "Reload this page to open TikTok."), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    onClick: onReload
  }, "Reload page")) : /*#__PURE__*/React.createElement("div", {
    className: "blocked-actions"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "secondary",
    onClick: () => setInner(true)
  }, "Open TikTok this time"), host === 'ios' ? /*#__PURE__*/React.createElement("p", {
    className: "manual"
  }, "To change this, open the Still app and turn off TikTok website.") : /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "link center",
    onClick: onOpenSettings
  }, "Change this in Still settings")), /*#__PURE__*/React.createElement(__ds_scope.Dialog, {
    open: open,
    contained: contained,
    title: "Open TikTok in this tab?",
    body: "TikTok opens in this tab until you close it. Other tabs stay closed, and your setting doesn't change.",
    confirmLabel: "Open TikTok this time",
    cancelLabel: "Keep it closed",
    onConfirm: () => {
      close();
      onOpenOnce && onOpenOnce();
    },
    onCancel: close
  }));
}
Object.assign(__ds_scope, { TikTokBlocked });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/blocked/TikTokBlocked.jsx", error: String((e && e.message) || e) }); }

// components/layout/Sheet.jsx
try { (() => {
function Sheet({
  open = true,
  title,
  body,
  onDismiss,
  dismissLabel = 'Cancel',
  contained = false,
  trapFocus = true,
  children
}) {
  const ref = __ds_scope.useModalFocus(open && trapFocus, onDismiss);
  if (!open) return null;
  const pos = contained ? {
    position: 'absolute'
  } : undefined;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "scrim",
    style: pos,
    onClick: onDismiss
  }), /*#__PURE__*/React.createElement("div", {
    ref: ref,
    className: "sheet",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": title,
    style: pos
  }, /*#__PURE__*/React.createElement("div", {
    className: "grip",
    "aria-hidden": "true"
  }), title && /*#__PURE__*/React.createElement("h2", null, title), body && /*#__PURE__*/React.createElement("p", {
    className: "body"
  }, body), children, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "dismiss",
    onClick: onDismiss
  }, dismissLabel)));
}
Object.assign(__ds_scope, { Sheet });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/Sheet.jsx", error: String((e && e.message) || e) }); }

// components/privacy/ConsentCard.jsx
try { (() => {
function ConsentCard({
  title = 'Share your email and usage data with Still?',
  body,
  purposes = [],
  never = 'Still never tracks or monitors the website you visit',
  shareLabel = 'Share',
  declineLabel = "Don't share",
  onShare,
  onDecline,
  footnote = 'Optional. Signing in or buying Still Pro never turns this on. Still works the same either way, and you can change it in Settings on this device.'
}) {
  const tid = 'consent-title';
  return /*#__PURE__*/React.createElement("section", {
    className: "card card-stack",
    "aria-labelledby": tid
  }, /*#__PURE__*/React.createElement("h2", {
    className: "card-title",
    id: tid
  }, title), body && /*#__PURE__*/React.createElement("p", {
    className: "card-body"
  }, body), purposes.length > 0 && /*#__PURE__*/React.createElement("ul", {
    className: "purpose-list"
  }, purposes.map(p => /*#__PURE__*/React.createElement("li", {
    key: p.name
  }, /*#__PURE__*/React.createElement("span", {
    className: "purpose-name"
  }, p.name), /*#__PURE__*/React.createElement("span", null, p.text)))), /*#__PURE__*/React.createElement("p", {
    className: "card-body"
  }, never), /*#__PURE__*/React.createElement("div", {
    className: "choice-actions"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "secondary",
    onClick: onDecline
  }, declineLabel), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "secondary",
    onClick: onShare
  }, shareLabel)), footnote && /*#__PURE__*/React.createElement("p", {
    className: "caption"
  }, footnote));
}
Object.assign(__ds_scope, { ConsentCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/privacy/ConsentCard.jsx", error: String((e && e.message) || e) }); }

// components/privacy/SharingSetting.jsx
try { (() => {
const W = {
  requested: ['pending', "Deletion requested. Your shared data hasn't been deleted yet."],
  verifying: ['pending', 'Confirming deletion with our providers…'],
  deleted: ['success', 'Your shared data has been deleted.'],
  failed: ['failed', "We couldn't send your deletion request. Sharing stays off on this device.", 'Try again']
};
function SharingSetting({
  checked = false,
  onChange,
  withdrawal = 'none',
  onRequestDeletion,
  onRetry,
  title = 'Share email and usage data',
  sub = 'Still never tracks or monitors the website you visit',
  announce = true
}) {
  const w = W[withdrawal];
  return /*#__PURE__*/React.createElement("section", {
    className: "card card-stack"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sync-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sync-row-text"
  }, /*#__PURE__*/React.createElement("span", {
    className: "row-title",
    id: "share-t",
    style: {
      fontSize: 'calc(15px * var(--text-scale, 1))',
      fontWeight: 600
    }
  }, title), /*#__PURE__*/React.createElement("span", {
    className: "muted sync-row-sub",
    id: "share-s"
  }, sub)), /*#__PURE__*/React.createElement(__ds_scope.Toggle, {
    checked: checked,
    onChange: onChange,
    labelledBy: "share-t",
    describedBy: "share-s"
  })), !checked && withdrawal === 'none' && onRequestDeletion && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "link",
    style: {
      fontSize: 'calc(13px * var(--text-scale, 1))'
    },
    onClick: onRequestDeletion
  }, "Delete data you already shared"), w && /*#__PURE__*/React.createElement(__ds_scope.StatusLine, {
    tone: w[0],
    actionLabel: w[2],
    onAction: onRetry,
    announce: announce
  }, w[1]));
}
Object.assign(__ds_scope, { SharingSetting });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/privacy/SharingSetting.jsx", error: String((e && e.message) || e) }); }

// components/sites/SiteInventory.js
try { (() => {
// The approved V3 control inventory. Each site's first row is its free core control (starts On); every Pro control starts Off.
// The section header switch is the service switch; TikTok has only that one whole-site switch.
// ids are engineering-owned; sidebar_ads keeps its legacy id. Hosts filter by real capability, not by this list.
const SiteInventory = {
  youtube: {
    name: 'YouTube',
    title: 'YouTube Blocker',
    service: 'Still on YouTube',
    controls: [{
      id: 'yt_shorts',
      label: 'Shorts',
      free: true,
      defaultOn: true
    }, {
      id: 'yt_related',
      label: 'Related videos'
    }, {
      id: 'yt_endscreen',
      label: 'End-of-video suggestions'
    }, {
      id: 'yt_autoplay',
      label: 'Autoplay prevention'
    }, {
      id: 'yt_comments',
      label: 'Comments'
    }, {
      id: 'yt_livechat',
      label: 'Live chat'
    }]
  },
  instagram: {
    name: 'Instagram',
    title: 'Instagram Blocker',
    service: 'Still on Instagram',
    controls: [{
      id: 'ig_reels',
      label: 'Reels',
      free: true,
      defaultOn: true
    }, {
      id: 'ig_stories',
      label: 'Stories and Highlights'
    }, {
      id: 'ig_explore',
      label: 'Explore recommendations',
      sub: 'Search stays.'
    }, {
      id: 'ig_suggested',
      label: 'Suggested accounts'
    }, {
      id: 'ig_threads',
      label: 'Threads links'
    }]
  },
  facebook: {
    name: 'Facebook',
    title: 'Facebook Blocker',
    service: 'Still on Facebook',
    controls: [{
      id: 'fb_reels',
      label: 'Reels',
      free: true,
      defaultOn: true
    }, {
      id: 'fb_stories',
      label: 'Facebook Stories'
    }, {
      id: 'fb_videos',
      label: 'Videos and Watch'
    }, {
      id: 'sidebar_ads',
      label: 'Desktop sidebar ads'
    }]
  },
  tiktok: {
    name: 'TikTok',
    title: 'TikTok Blocker',
    service: 'TikTok website',
    controls: []
  }
};
const SiteOrder = ['youtube', 'instagram', 'facebook', 'tiktok'];
function ProControlList(hostFilter) {
  const out = [];
  SiteOrder.forEach(k => SiteInventory[k].controls.forEach(c => {
    if (c.free) return;
    if (!hostFilter || hostFilter(c)) out.push({
      site: SiteInventory[k].name,
      label: c.label,
      id: c.id
    });
  }));
  return out;
}
Object.assign(__ds_scope, { SiteInventory, SiteOrder, ProControlList });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/sites/SiteInventory.js", error: String((e && e.message) || e) }); }

// components/sites/SwitchRow.jsx
try { (() => {
const HOST = {
  browser: 'this browser',
  safari: 'Safari',
  apple: 'this app'
};
function SwitchRow({
  id,
  label,
  sub,
  checked = false,
  onChange,
  access = 'free',
  inactive = false,
  inactiveNote,
  host = 'browser',
  unavailableNote,
  onAccessAction
}) {
  const key = (id || label).replace(/\W+/g, '-');
  const usable = access === 'free' || access === 'protected' || access === 'purchased';
  let note = sub,
    action = null,
    tag = null,
    control = null;
  const srNote = access === 'checking' ? 'Checking your Still Pro access. Your choice is saved.' : access === 'verify' ? 'Verify Still Pro to use this. Your choice is saved.' : null;
  if (access === 'unsupported') note = unavailableNote ?? 'Not available in ' + HOST[host] + '. Your choice is saved.';
  if (usable && inactive) note = inactiveNote ?? sub;
  if (usable || access === 'checking' || access === 'verify') {
    control = /*#__PURE__*/React.createElement(__ds_scope.Toggle, {
      size: "small",
      checked: checked,
      onChange: onChange,
      disabled: inactive || !usable,
      labelledBy: key + '-l',
      describedBy: note || srNote ? key + '-s' : undefined
    });
  } else if (access === 'locked') {
    const aria = label + '. Included in Still Pro. ' + (host === 'safari' ? 'Open the Still app' : 'See Still Pro');
    control = /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "lock-pro",
      "aria-label": aria,
      onClick: onAccessAction
    }, /*#__PURE__*/React.createElement(__ds_scope.Glyph, {
      name: "lock",
      size: 14
    }), /*#__PURE__*/React.createElement("span", null, "Still Pro"));
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "option-row",
    "data-access": access,
    "data-inactive": inactive || access === 'unsupported' || access === 'locked' || undefined
  }, /*#__PURE__*/React.createElement("div", {
    className: "row-main"
  }, /*#__PURE__*/React.createElement("span", {
    className: "label"
  }, /*#__PURE__*/React.createElement("span", {
    id: key + '-l'
  }, label), tag), note && /*#__PURE__*/React.createElement("span", {
    className: "sub",
    id: key + '-s'
  }, note), !note && srNote && /*#__PURE__*/React.createElement("span", {
    className: "sr-only",
    id: key + '-s'
  }, srNote), action && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "link row-action",
    onClick: onAccessAction
  }, action)), control);
}
Object.assign(__ds_scope, { SwitchRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/sites/SwitchRow.jsx", error: String((e && e.message) || e) }); }

// components/sites/SiteSection.jsx
try { (() => {
function SiteSection({
  service,
  serviceOn,
  onServiceChange,
  coreOn,
  onCoreChange,
  values = {},
  access = {},
  onControlChange,
  open = false,
  onToggleOpen,
  paused = false,
  host = 'browser',
  showSubs = true,
  onAccessAction,
  controls
}) {
  const site = __ds_scope.SiteInventory[service] || {
    controls: []
  };
  const list = controls ?? site.controls;
  const multi = list.length > 0;
  const svcOn = serviceOn ?? coreOn ?? true;
  const onSvc = onServiceChange ?? onCoreChange;
  const panel = 'site-' + service + '-panel',
    head = 'site-' + service + '-h';
  const text = /*#__PURE__*/React.createElement("span", {
    className: "text"
  }, /*#__PURE__*/React.createElement("span", {
    className: "name",
    id: head
  }, site.title ?? site.name));
  return /*#__PURE__*/React.createElement("div", {
    className: "site-section",
    "data-paused": paused || undefined
  }, /*#__PURE__*/React.createElement("div", {
    className: "service-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "icon"
  }, /*#__PURE__*/React.createElement(__ds_scope.ServiceIcon, {
    service: service
  })), multi ? /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "expander",
    "aria-expanded": open,
    "aria-controls": panel,
    onClick: onToggleOpen
  }, text, /*#__PURE__*/React.createElement(__ds_scope.Glyph, {
    name: "chevron",
    className: "chevron"
  })) : /*#__PURE__*/React.createElement("div", {
    className: "expander",
    style: {
      cursor: 'default'
    }
  }, text), /*#__PURE__*/React.createElement(__ds_scope.Toggle, {
    checked: svcOn,
    onChange: onSvc,
    disabled: paused,
    label: site.service
  })), multi && /*#__PURE__*/React.createElement("div", {
    id: panel,
    className: open ? 'service-options open' : 'service-options',
    role: "group",
    "aria-labelledby": head
  }, /*#__PURE__*/React.createElement("div", {
    className: "inner"
  }, /*#__PURE__*/React.createElement("div", {
    className: "list"
  }, list.map(c => /*#__PURE__*/React.createElement(__ds_scope.SwitchRow, {
    key: c.id,
    id: c.id,
    label: c.label,
    sub: showSubs ? c.sub : undefined,
    checked: values[c.id] ?? !!c.defaultOn,
    access: c.free ? 'free' : access[c.id] ?? 'checking',
    inactive: paused || !svcOn,
    host: host,
    onChange: v => onControlChange && onControlChange(c.id, v),
    onAccessAction: () => onAccessAction && onAccessAction(c.id)
  }))))));
}
function SiteList({
  children,
  paused = false,
  scroll = false
}) {
  const kids = React.Children.toArray(children).filter(Boolean);
  return /*#__PURE__*/React.createElement("div", {
    className: scroll ? 'service-group site-scroll services' : 'service-group services',
    "data-paused": paused || undefined
  }, kids.map((k, i) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: i
  }, i > 0 && /*#__PURE__*/React.createElement("div", {
    className: "divider"
  }), k)));
}
Object.assign(__ds_scope, { SiteSection, SiteList });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/sites/SiteSection.jsx", error: String((e && e.message) || e) }); }

__ds_ns.AccessTag = __ds_scope.AccessTag;

__ds_ns.AccountLink = __ds_scope.AccountLink;

__ds_ns.ProOffer = __ds_scope.ProOffer;

__ds_ns.RestoreStatus = __ds_scope.RestoreStatus;

__ds_ns.TikTokBlocked = __ds_scope.TikTokBlocked;

__ds_ns.Logo = __ds_scope.Logo;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Glyph = __ds_scope.Glyph;

__ds_ns.OpenSettingsButton = __ds_scope.OpenSettingsButton;

__ds_ns.TextField = __ds_scope.TextField;

__ds_ns.Toggle = __ds_scope.Toggle;

__ds_ns.Invitation = __ds_scope.Invitation;

__ds_ns.OwnerAllowances = __ds_scope.OwnerAllowances;

__ds_ns.DemoMark = __ds_scope.DemoMark;

__ds_ns.StatusLine = __ds_scope.StatusLine;

__ds_ns.AppShell = __ds_scope.AppShell;

__ds_ns.Dialog = __ds_scope.Dialog;

__ds_ns.HeroCard = __ds_scope.HeroCard;

__ds_ns.ServiceIcon = __ds_scope.ServiceIcon;

__ds_ns.SettingsCard = __ds_scope.SettingsCard;

__ds_ns.AccountLinks = __ds_scope.AccountLinks;

__ds_ns.Sheet = __ds_scope.Sheet;

__ds_ns.ConsentCard = __ds_scope.ConsentCard;

__ds_ns.SharingSetting = __ds_scope.SharingSetting;

__ds_ns.SiteInventory = __ds_scope.SiteInventory;

__ds_ns.SiteOrder = __ds_scope.SiteOrder;

__ds_ns.ProControlList = __ds_scope.ProControlList;

__ds_ns.SiteSection = __ds_scope.SiteSection;

__ds_ns.SiteList = __ds_scope.SiteList;

__ds_ns.SwitchRow = __ds_scope.SwitchRow;

})();
