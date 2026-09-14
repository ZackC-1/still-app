---
title: Organize developer navigation without moving framework inputs
category: conventions
track: knowledge
problem_type: maintainability
module: repository
applies_when: Cleaning a multi-platform repository while preserving releases and project history
date: 2026-09-14
status: active
tags: [documentation, repository, preservation]
---

## Problem

A repository can have appropriate runtime boundaries while still being difficult to navigate.
Renaming source folders for visual consistency creates work for Xcode references, framework
entrypoints and release reproduction without helping readers understand those boundaries.

## Approach

Use established repositories as evidence of patterns, then compare those patterns with actual
consumers. Still already separates its shared core, browser shells, Apple host, backend and tests.
Component README guides, a complete root map and one canonical glossary address the navigation gap.
Keep a small compatibility pointer where existing tools require an older document name.

Move research and historical operational records into their respective documentation folders.
Preserve their contents and repair both incoming and internal relative links. Keep unique testing
evidence and architectural reasoning even when the original release is complete. Dates alone do
not establish that a record is disposable.

## Verification

Compare every non-document byte with the baseline. For moved documents, normalize only the
expected relative-link changes and compare the remaining contents. Check that merged glossary
definitions survived, existing anchors still resolve and new guides name real package commands.
Run normal protected CI without replacing already-submitted store artifacts.

This method preserved all 403 non-Markdown files and three moved documents during the
[September 14 organization pass](../../plans/2026-09-14-repository-organization.md).
The [reference research](../../research/2026-09-14-extension-repository-layout.md) records which
patterns were adopted and why runtime-path changes were unnecessary.

## Keep current behavior separate from historical design

A short free-release banner is insufficient when the rest of a reference still directs a paid
activation flow. Create a current behavior specification, keep stable reference paths current,
and preserve superseded originals in a labeled archive. Pin archived links to the original commit
so old procedures do not silently acquire newer targets. Preserve dated test hashes and observations;
add a later-status pointer instead of rewriting them as tests of the newest build.

Treat source defaults, export-time settings and submitted artifacts as separate evidence. A
checked-in build number can differ from the submitted package; document the provenance instead of
rebuilding a pending release to make the numbers match. Validate archive text, links/anchors and
unchanged non-document bytes before claiming the refresh preserved information and functionality.
