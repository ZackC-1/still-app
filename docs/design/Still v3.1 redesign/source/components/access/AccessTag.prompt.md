Words for access state. SwitchRow shows no tag for protected or purchased rows; locked rows use the right-aligned lock + "Still Pro" button instead.

```jsx
<AccessTag state="locked" />   {/* lock + Included in Still Pro */}
<AccessTag state="protected" /> {/* Yours to keep */}
```

- free: nothing. protected / purchased: usable, tag only. checking: clock, no lock, no sale. verify: alert, free stays usable. locked: known missing Pro only. unsupported: host can't do it; choice stays saved.
