A Still text input with optional label, hint and error line; used for email and 6-digit codes in the sign-in Sheet.

```jsx
<TextField label="Email address" type="email" placeholder="you@example.com" />
<TextField label="6-digit code" code error="That code didn't work. Check it and try again." />
```

- `border` outline, `radius-control`, `surface` fill; focus turns the border `still-blue`.
- Errors give cause and next step in one line.
