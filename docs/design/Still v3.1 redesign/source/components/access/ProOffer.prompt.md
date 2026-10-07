The Still Pro offer card for eligible hosts. Feed it verified offer strings and the host's real Pro controls.

```jsx
<ProOffer host="browser" signedIn offer={{ price: verified.price, priceNote: verified.note, refundNote: verified.refund }} controls={proControls} onBuy={buy} onRestore={restore} />
<ProOffer host="safari" controls={proControls} onOpenHost={openApp} />
```

- Approved price line: "One payment. Access forever. No subscription" (passed as offer.priceNote). No refund wording, no count, no trial language.
- ownership="owned" or "checking" never shows Buy: existing rights don't become a duplicate-charge prompt.
- Apple host: Buy hands off to native StoreKit; don't draw the Apple sheet.
