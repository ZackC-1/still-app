A `surface-raised` card (no border, no shadow) holding a setting row, a titled stack like Settings sync, or the popup's one-line sync row.

```jsx
<SettingsCard variant="row" title="Share usage data" sub="Helps improve Still. Never includes the sites or videos you visit." checked={share} onChange={setShare} />
<SettingsCard label="Settings sync">
  <p className="muted">Sign in to keep your settings the same across your devices.</p>
  <Button block>Sign in to sync</Button>
  <AccountLinks><Button variant="link">Privacy policy</Button></AccountLinks>
</SettingsCard>
<SettingsCard variant="sync-row" title="Settings sync" sub="Keep your settings the same across your devices." action={<Button inline>Sign in to sync</Button>} />
```
