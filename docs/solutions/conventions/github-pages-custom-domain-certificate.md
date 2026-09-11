---
title: Verify DNS and certificate issuance separately for GitHub Pages
date: 2026-09-10
category: conventions
track: knowledge
module: website
applies_when: Moving GitHub Pages to a custom domain with Namecheap DNS
status: active
tags: [dns, github-pages, https]
---

Correct DNS and an HTTP 200 do not establish HTTPS readiness. GitHub can serve the site while its
custom-domain certificate is still missing, causing certificate-name verification to fail.

For a Pages apex domain, remove Namecheap's conflicting default apex redirect and parking CNAME;
retain the four GitHub Pages A records and the www CNAME to the account's github.io hostname.
Preserve unrelated email records. Check the authoritative/public DNS and Pages health endpoint.

If certificate provisioning stays pending after DNS becomes valid, GitHub's documented recovery
is to remove and immediately restore the same custom domain. This restarts provisioning and can
create CNAME commits on the publishing branch; fetch that branch afterward. When the certificate
is approved, enable HTTPS enforcement and verify a valid HTTPS 200 plus an HTTP redirect. Never
use disabled certificate verification as evidence that the migration succeeded.

This procedure was verified for stillapp.fit: the certificate became approved after provisioning
was restarted, HTTPS enforcement succeeded, and the homepage, privacy, support, setup, sitemap,
and robots URLs returned 200 with normal certificate verification.

The site publishes from gh-pages, independently of main. Keep both the publishing branch and
the application URL constants consistent; source merges alone do not deploy gh-pages content.

Reference: [GitHub certificate troubleshooting](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https#troubleshooting-certificate-provisioning-certificate-not-yet-created-error).
