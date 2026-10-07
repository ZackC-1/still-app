The switch for every on/off in Still (52 × 31px, 160ms motion); use `variant="on-blue"` only inside the blue HeroCard.

```jsx
<Toggle label="Still on YouTube Shorts" checked={on} onChange={setOn} />
<Toggle label="Still on/off" variant="on-blue" defaultChecked />
<Toggle label="Shorts on YouTube" size="small" />
```

- Track `toggle-off` → `still-blue`; knob white with `shadow-knob`.
- `label` is required and should match the visible title.
