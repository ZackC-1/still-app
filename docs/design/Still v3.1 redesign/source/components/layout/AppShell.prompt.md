The Still page column and density switch; wrap every Still screen in it so tokens, focus rings and compact mode apply.

```jsx
<AppShell density="compact" width={380}>
  <HeroCard on compact />
  <ServiceList grouped>…</ServiceList>
</AppShell>
```

- Comfortable: 432px max, 16px padding, 12px gaps. Compact: 12px padding, 8px gaps, 32px service icons.
