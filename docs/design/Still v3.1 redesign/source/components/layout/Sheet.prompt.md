A Still bottom sheet: grip, 22px title, one body line, fields, one primary button, quiet dismiss.

```jsx
<Sheet title="Sign in for settings sync" body="Enter your email to get a 6-digit sign-in code. Sign-in is optional. Blocking works without an account." onDismiss={close}>
  <TextField type="email" placeholder="you@example.com" />
  <Button>Send code</Button>
</Sheet>
```

- Scrim rgba(11,20,48,.45); width capped at 420px; top corners 16px. Trap focus in production.
