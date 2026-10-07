A quiet card with one action and "Not now". Never during setup, consent, errors, purchase or Restore.

```jsx
<Invitation kind="sync" onAccept={openSignIn} onDismiss={snooze} />
<Invitation kind="rating" store="Firefox Add-ons" onAccept={openStore} onDismiss={done} />
```

- Sync/link takes precedence over rating. No sentiment gate ("Enjoying Still?"), no thank-you after rating.
