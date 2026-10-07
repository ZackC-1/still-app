Site sections for the popup and settings. Wrap them in SiteList; keep one open at a time.

```jsx
<SiteList paused={!stillOn} scroll>
  <SiteSection service="youtube" serviceOn={v.youtube} values={v} access={access} open={open === 'youtube'} onToggleOpen={() => setOpen(open === 'youtube' ? null : 'youtube')} paused={!stillOn} showSubs={false} />
  <SiteSection service="tiktok" serviceOn={v.tiktok} paused={!stillOn} />
</SiteList>
```

- Header says only the section title ("YouTube Blocker"). The free core control (Shorts / Reels) is the first row inside.
- TikTok has no expander: one whole-site switch in the header.
- Order: YouTube, Instagram, Facebook, TikTok (SiteOrder).
