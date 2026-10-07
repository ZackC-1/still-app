Still's button: use `primary` for the one main action in a card, `secondary` for a quiet confirm, `link` for tertiary actions, and `danger-*` only for account deletion.

```jsx
<Button block>Sign in to sync</Button>
<Button variant="secondary">OK</Button>
<Button variant="link">Privacy policy</Button>
<Button variant="danger-link">Delete account</Button>
```

- `block`: full width, 44px min height. `inline`: 36px/14px for the compact sync row.
- Hover darkens to `still-blue-pressed`; primary presses down 1px. Disabled = 60% opacity.
- Labels are sentence case, no exclamation marks.
