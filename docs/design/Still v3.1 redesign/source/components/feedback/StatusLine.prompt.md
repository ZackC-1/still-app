The single pattern for operation state: sync, purchase, restore, linking, deletion, owner apply.

```jsx
<StatusLine tone="pending">Checking for Still Pro purchases…</StatusLine>
<StatusLine tone="failed" detail="Your free controls and saved choices are unaffected." actionLabel="Try again" onAction={retry}>We couldn't finish checking. Nothing changed.</StatusLine>
```

- Say what happened, then what still works. Pending is never success: "Deletion requested" is not "Deleted".
- Spinner stops under reduced motion.
