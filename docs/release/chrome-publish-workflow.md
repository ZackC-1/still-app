# Chrome Web Store release workflow

`.github/workflows/release-chrome.yml` builds the Chrome package and, step by step and only with the
owner's approval, puts it in the Chrome Web Store. It replaces uploading the zip by hand in the
dashboard, which stays available as the fallback for any problem.

## What it will and will not do

- It starts only when someone presses **Run workflow** on the Actions tab, on `main`. Pushes, pull
  requests and merges never start it. Merging a change to the workflow publishes nothing.
- Every run stops and waits for the owner's approval in the `chrome-release` environment. Runs that
  touch the store wait twice: once to build, once more before signing in to Google.
- There is no stored password, key or refresh token. GitHub proves to Google that this exact workflow
  file, on `main`, in `chrome-release`, started by hand, is asking. Google then lends it a Chrome Web
  Store token for at most 15 minutes (5 minutes for read-only checks). If that sign-in fails, the run
  stops. There is no other way in.
- It never cancels a review, never changes a rollout percentage, never tries to skip review and never
  repeats an upload or a submission on its own. Cancelling a review is done in the dashboard.
- A submitted update goes live to everyone once Google approves it. Still is too small for Chrome's
  partial rollouts (that needs more than 10,000 weekly users), and by owner decision staged holds are not used.
  To undo a bad release, ship a higher version with the earlier code, or cancel in the dashboard while
  it is still in review.

## Modes

| Mode | What happens | Touches the store? |
|---|---|---|
| `package-only` (default) | Builds the chosen commit and prints the package fingerprint (SHA-256). The zip is kept as a run artifact for testing. | No |
| `status` | Also signs in read-only and reports the store's published and in-review versions. | Reads only |
| `upload` | Also uploads the package as a dashboard draft. Nothing is sent for review. | Draft only |
| `upload-and-submit` | Also submits that draft for Google's review. Needs `confirm_submit` typed exactly as `submit <version>`. | Yes |

Inputs: `commit` (full 40-character SHA on `main`), `version` (must equal `version.json` `extension` at
that commit), `chrome_zip_sha256` (the fingerprint from a `package-only` run; required for every other
mode), `confirm_submit`.

## A normal release

1. Bump `extension` in `version.json` (see [versioning and packages](versioning-and-packages.md)) and merge.
2. Run `package-only` with that commit and version. Approve the build. Copy the fingerprint from the run
   summary and download the `chrome-package` artifact.
3. Test that exact zip (load it unpacked). The fingerprint names exactly what you tested; the build uses a
   fixed Node version, so a zip built on your own computer may have a different fingerprint.
4. Run `upload-and-submit` with the same commit, version and fingerprint, and `confirm_submit` set to
   `submit <version>`. Approve the build, then approve the store step.

   `upload` on its own is for checking the draft in the dashboard first. A later `upload-and-submit` uploads
   again before submitting, because the store does not report a draft's version. Whether the store accepts
   the same version over an existing draft has not been observed yet; if it refuses, submit that draft in
   the dashboard instead.

**While a run is in progress, nobody changes a draft by hand in the dashboard** (no manual package upload,
no discarding the draft). The store keeps only one draft and reports only the state of the most recent
upload, not which package it was. The run waits on that state after uploading. A hand-made change in the
meantime could make the run treat someone else's upload as its own, and then submit it. Wait until the
run has finished (its summary shows the outcome) before touching the dashboard.

Before uploading, the run checks that the store has a lower version and that nothing else is in review.
If a previous run already submitted this version, a re-run reports that and writes nothing.

## Owner settings this workflow needs

In GitHub **Settings, Environments, `chrome-release`, Environment variables** (variables, not secrets):

| Name | Value |
|---|---|
| `CWS_WORKLOAD_IDENTITY_PROVIDER`, `CWS_SERVICE_ACCOUNT` | Already set (October 1 setup). |
| `CWS_PUBLISHER_ID` | From the Chrome Developer Dashboard, Account. |
| `CWS_EXTENSION_ID` | `midpefhbieafmeboompbboemeahjjnkf` (public; it is in the store address). |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST` | The public build values the shipped extension uses. Required. |
| `VITE_MODERN_SETTINGS_SYNC_ENABLED` | Only if the release turns modern sync on; otherwise leave unset. |

These are identifiers and public values, not credentials. GitHub shows a step's variables in the run log,
and this repository's logs are public, so they will be visible there. None of them lets anyone publish:
publishing needs the owner-approved run.

Recommended (optional): set the environment's deployment branches to **Selected branches: main**. The
workflow and Google already refuse anything but `main`; this adds a third lock.

## When a run stops

Every refusal starts with `STOP (<reason>)`. The common ones:

| Reason | Meaning and what to do |
|---|---|
| `input-invalid` | A typo in the inputs. Fix and run again. |
| `package-mismatch` | The rebuilt package is not the one with that fingerprint. Run `package-only` again and test the new zip. |
| `commit-not-on-main` / `version-mismatch` | The commit is not on `main`, or its `version.json` says another version. |
| `paid-flag-on` | The commit has the paid tier switched on. Store packages never do. |
| `protection` | The approval rules changed (reviewer, admin bypass, branches) or someone other than the owner approved. Restore the rules. `oidc-subject-changed` means the repository was renamed or switched to GitHub's new token format, so Google's trust rule must be updated before any run can sign in. |
| `store-access-denied` | Keyless sign-in or the dashboard's service-account link is not working. There is no fallback: upload by hand while it is fixed. |
| `version-not-higher` | The store already has this or a higher version. Bump the version. |
| `other-version-in-review` / `staged-submission-exists` | Something else is in review or waiting. Decide in the dashboard; the workflow never cancels it. |
| `item-warned` / `item-taken-down` | Google has flagged the item. Handle it in the dashboard first. |
| `upload-still-processing` | Google is still processing the upload. Run `status` later; do not upload again. |
| `store-version-mismatch` | The store read a different version than expected. Nothing was submitted, or (after submitting) cancel in the dashboard. |

Each run that reaches the store leaves a `chrome-release-receipt` artifact and a short summary on the run
page: mode, version, commit, fingerprint, what the store reported, and the outcome. No token or publisher
ID is ever written to it.

## Things that break sign-in on purpose

Google's trust rule names this file path, `main`, the `chrome-release` environment, a manual start and
this repository. Renaming or copying the workflow file, renaming the repository, opting the repository
into GitHub's immutable token subjects, or running it from another branch all make sign-in fail. Change
Google's rule first (owner action), never the other way round.

## Tests

`pnpm test:chrome-release` (also part of `pnpm test:release`, which CI runs) checks the workflow file's
structure and the store script against an in-memory fake store. Nothing in the tests reaches the network.
They cannot prove Google's or GitHub's live behaviour; the first `status` run is the live proof of keyless
sign-in.
