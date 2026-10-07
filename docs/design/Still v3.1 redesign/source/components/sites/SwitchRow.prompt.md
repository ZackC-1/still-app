A labelled switch row for one Still control, with access state built in.

```jsx
<SwitchRow label="Comments" sub="Live chat is separate." checked={v.yt_comments} access="purchased" onChange={set('yt_comments')} />  {/* owned: no tag */}
<SwitchRow label="Live chat" access="locked" host="safari" onAccessAction={openApp} />
```

- checking: toggle visible at saved state, disabled, no lock, no price.
- locked: only for known missing Pro. Right-aligned lock + "Still Pro" where the switch would be. Browser/Apple: opens the offer. Safari: opens the Still app, no price.
- unsupported: no switch; "Not available in Safari. Your choice is saved."
