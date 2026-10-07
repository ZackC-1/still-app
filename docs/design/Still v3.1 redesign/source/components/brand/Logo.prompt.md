The Still logo lockup for the top of the roomy app column (settings page, app window); never in the compact popup.

```jsx
<div className="appbar"><Logo /></div>
```

- Mark fills with `still-blue` (reads the token, so it follows dark mode); line and ball are always white.
- The wordmark inverts to white under `[data-theme="dark"]`. Never recolor or redraw the mark.
