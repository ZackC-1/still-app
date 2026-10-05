# Owner admin page

A small private page for the Still owner. It shows and changes the two remote switches Still has:
which surfaces may show the rating prompt, and whether sales is allowed. The server decides who may
use it: after email-code sign-in, every call is checked against the owner allowlist on the server.
Anyone else sees "Not available here". The page holds no secret.

This folder is **not** the website. The built page goes live only when the owner approves a website
publish (see "Publishing" below). Nothing here touches `docs/`.

## What it does

- Sign in with the same emailed 6-digit code as every Still surface (Supabase email OTP, public anon
  key). The session lives in memory only; closing the tab signs out. It never creates an account.
- Read both policies for the chosen environment from `product-policy-admin` with the signed-in
  user's own session token.
- **Apply** = preview → apply (with the preview's operation id, hash, body and expected revision) →
  the page's own authoritative read. "Applied and read back. The server matches." appears only when
  that read shows exactly the applied revision, body and operation. If the apply reply is lost, the
  same operation is retried (the server makes it idempotent), then the read decides.
- Stale (someone else changed it), failed (nothing changed, proven by the read), unconfirmed (the
  read failed) and the server's sales refusal before the paid cutoff (R4) each have their own line.
- **Undo last change** republishes the previous revision's values at a new revision (rollback).
- A 403 at any point shows only "Not available here".
- No analytics, no third-party scripts, no tracking, no storage. Strict CSP meta, `noindex, nofollow`,
  `no-referrer`.

### Approved builds (known gap)

Each policy also holds a list of approved app builds, and the server and every client treat a
surface as switched on only when one of its builds is on that list. This page cannot add builds: it
carries the list through unchanged, and nothing else fills it yet. So today, with no builds listed,
turning rating prompts or sales on and pressing Apply succeeds and reads back, but has no effect in
any app. Each section says so in a line of its own while its list is empty, and "After Apply,
prompts are allowed on …" follows the same rule, so it lists no surface without an approved build.
Who fills the list, and how, is an open owner question; until it is answered this page is a way to
switch things off, or to record a decision, not to turn anything on in the apps.

## Commands

From the repository root:

- `pnpm --filter @still/owner-admin build`: build `dist/index.html` (one self-contained file), then
  run the bundle guard over it.
- `pnpm --filter @still/owner-admin test`: unit and component tests with a fake admin function.
- `pnpm --filter @still/owner-admin typecheck`
- `pnpm --filter @still/owner-admin e2e`: builds with a made-up local config, serves the file on
  `127.0.0.1:4317` and drives it in Chromium with the Supabase endpoints mocked.

Configuration is read from the environment at build time, exactly like the extensions:
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (both public). With neither set the page builds and
shows "Not available here". The key must be a publishable key (`sb_publishable_…`) or a JWT whose
role is `anon` (for a hosted `https://<ref>.supabase.co` URL, issued by `supabase` and, when it names
a project ref, naming that same project); the only other value accepted is an obvious placeholder (for example CI's
`public-audit-placeholder`) paired with a placeholder URL (`*.invalid` or loopback). Anything else
(a secret key, a personal access token, a JWT signing secret, a database URL, another provider's
key), a half configuration or a non-https URL fails the build.

### Bundle guard

`scripts/bundle-guard.mjs` scans the finished file and fails the build when:

- a Supabase secret key or personal access token, any JWT whose role isn't `anon`, another
  provider's secret key or a database URL with a password is in it, or `VITE_SUPABASE_ANON_KEY`
  itself isn't a key the page may ship;
- the value of any other sensitive-looking environment variable (from this process or the app's
  `.env` files) is in it; only variable names are ever printed. A credential-named variable is never
  excused for repeating the shipped value, unless it is the anon key under another name;
- the CSP meta, the robots `noindex, nofollow` meta or the no-referrer meta is missing, the CSP is
  looser than the fixed policy, or an inline script or style isn't covered by its hash;
- anything loads from a file or another site, or an analytics or tracking reference appears;
- the output is more than the one `index.html`.

## Publishing (owner-gated, a separate step)

Merging anything under `docs/` publishes the live website, so this is its own pull request, opened
only after the owner approves it. Before that PR:

1. **Server ready (production, owner-approved).** Migration 0016 and the `product-policy-admin`
   function are deployed through the protected deploy, the function's database login secret is set,
   and the owner's Still account user id is on the server-side owner allowlist. Without the
   allowlist entry the owner also sees "Not available here".
2. **Copy approved.** Replace every `PENDING_OWNER_COPY` line in `src/copy.ts` with the owner's
   wording (see the questions below).
3. **Build with the production public config:**

   ```bash
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co \
   VITE_SUPABASE_ANON_KEY=<public anon key> \
   pnpm --filter @still/owner-admin build
   ```

4. **Pick an unlisted path** that is hard to guess, for example `openssl rand -hex 12`. Unlisted is
   not the protection (the server allowlist is); it only keeps the page out of casual view. Do not
   add it to `docs/sitemap.xml`, do not link it from any page, and do not name it in `robots.txt`
   (a `Disallow` line would advertise it).
5. **Copy the one file and re-check it in place:**

   ```bash
   mkdir -p docs/<slug>
   cp apps/owner-admin/dist/index.html docs/<slug>/index.html
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co VITE_SUPABASE_ANON_KEY=<public anon key> \
     node apps/owner-admin/scripts/bundle-guard.mjs docs/<slug>/index.html
   ```

6. Open the PR with only that file, get the owner's approval, merge. Then sign in on
   `https://stillapp.fit/<slug>/` and confirm the current state reads back.

To unpublish, delete `docs/<slug>/` in another owner-approved PR. Removing the owner from the server
allowlist turns the page off immediately without touching the website.

## Owner copy questions

Every line below is provisional (`PENDING_OWNER_COPY` in `src/copy.ts`); the approved D28 lines and
the shipped sign-in wording are used everywhere else.

1. Environment picker: label "Environment", options "Sandbox" and "Production". Which should open
   first? (It opens on Sandbox.)
2. Sales section: title "Sales", line "Off until you allow it. Nothing changes until Apply.", switch
   "Sales allowed", and the progress line "Reading back the saved sales setting…".
3. The server's refusal to turn sales on before the paid cutoff: "The server refused: sales can't
   turn on until the paid cutoff is set up. Nothing changed."
4. Apply was sent but the readback failed: "Apply was sent but couldn't be read back. Reload to see
   the current state."
5. Loading failed: "Couldn't load the current state. Try again."
6. Rollback action: "Undo last change".
7. The page heading is the word "Still" and the browser tab title is "Still".
8. While no approved builds are listed, each section says: "No approved app builds are listed yet, so
   switching this on has no effect until they are."
