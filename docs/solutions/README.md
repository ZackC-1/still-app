# Durable solution knowledge

This directory is Still's institutional memory for verified, reusable engineering and operational
learnings. Claude Code, Codex Personal, and Codex Work must search it before repeating an
investigation.

Solution documents are not plans, progress reports, release status, or raw transcripts. They explain
a problem that was actually understood and a solution that was actually verified.

## Capture workflow

1. Search this directory for the same symptom, root cause, subsystem, and affected files.
2. If an existing document covers the same problem and solution, update it instead of creating a
   duplicate.
3. Use `/ce-compound` in Claude Code or `$ce-compound` in Codex whenever available.
4. Choose the category that describes the reusable lesson, not merely the file that changed.
5. Include evidence: tests, commands, observed behavior, or a linked accepted decision.
6. Commit the document with the supporting change when practical.

## Required qualities

A durable solution should make the next encounter faster by recording:

- The symptom or context that makes the issue recognizable.
- The underlying cause or decision pressure.
- Approaches that failed when knowing about them prevents repeated work.
- The implemented solution or guidance.
- Why the solution works and where it does not apply.
- Verification evidence.
- Prevention rules, tests, or review checks.
- Current paths and cross-references to relevant ADRs, plans, or related solutions.

Never include secrets, customer data, speculative conclusions, or a portal status likely to change.

## Frontmatter

Follow the existing solution documents. New entries should normally include:

```yaml
---
title: Concise statement of the reusable lesson
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core
applies_when: A short description of when this guidance is relevant
date: 2026-07-14
status: active
tags:
  - entitlement
  - cross-platform
---
```

Use `last_updated` when refreshing an existing entry. Use `status: stale` only when the guidance is
known to be unreliable but there is not yet enough evidence for a correct replacement.

## Categories

Current categories include:

- `architecture-patterns/`
- `conventions/`
- `design-patterns/`
- `logic-errors/`
- `security-issues/`
- `ui-bugs/`

Create a new category only when multiple durable learnings are likely to belong there. Avoid one-file
taxonomies.

## Maintenance

Use a focused `/ce-compound-refresh <scope>` or `$ce-compound-refresh <scope>` after a meaningful
refactor, when a new solution contradicts an older one, or before a major release. Prefer update,
consolidation, or replacement over accumulating partially correct documents.

The maintenance result must preserve useful historical reasoning while making the current guidance
unambiguous.
