A short confirmation: TikTok one-time open, account deletion, unlinking.

```jsx
<Dialog open={confirm} title="Open TikTok in this tab?" body="…" confirmLabel="Open TikTok this time" cancelLabel="Keep it closed" onConfirm={allow} onCancel={close} />
```

- Actions stack full-width, confirm first; focus lands on cancel. Use Sheet for forms (sign-in), Dialog for yes/no.
