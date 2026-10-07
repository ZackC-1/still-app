Asks once, per device, for the one combined choice: email plus usage data, with the approved analytics/AI purposes. Never claims anonymity. Both buttons are the same style and size.

```jsx
<ConsentCard purposes={approvedPurposes} onShare={share} onDecline={decline} />
```

- Purposes are supplied text; never invent providers. No geographic variants, no second AI toggle.
- Declining changes nothing about blocking, sync or purchases.
