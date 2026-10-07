The "Settings" link in the compact popup footer, set beside the Privacy policy link.

```jsx
<footer className="popup-footer">
  <OpenSettingsButton setupTitle="Find Still in Chrome." />
  <Button variant="link" href="/privacy/">Privacy policy</Button>
</footer>
```

- 13px (inherited from `.popup-footer`), `still-blue`, underline on hover. Accessible name starts with the visible text.
