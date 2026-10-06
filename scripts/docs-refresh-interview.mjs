#!/usr/bin/env node
// Plain-English interview: produces a docs-refresh plan for owner approval.
// This script only WRITES one new plan file. It never edits or deletes docs.
import { createInterface } from "node:readline";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_CANONICAL = [
  "STRATEGY.md",
  "CONCEPTS.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/README.md",
  "docs/PRODUCT.md",
  "docs/ARCHITECTURE.md",
  "docs/CONNECTIONS.md",
  "docs/MEMORY.md",
  "docs/SHARED-BRAIN.md",
  "README.md",
];

const args = process.argv.slice(2);
function flag(name, fallback) {
  const hit = args.find((a) => a.startsWith(name + "="));
  return hit ? hit.slice(name.length + 1) : fallback;
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/docs-refresh-interview.mjs [--out=PATH] [--date=YYYY-MM-DD]

Asks plain-English questions, then writes ONE new dated plan file.
Defaults: --out=docs/plans/<date>-docs-refresh-plan.md, --date=today.`);
  process.exit(0);
}

const today = flag("--date", new Date().toISOString().slice(0, 10));
const defaultOut = join("docs/plans", `${today}-docs-refresh-plan.md`);
const outPath = resolve(flag("--out", defaultOut));

function readStdinLines() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data.split("\n").map((l) => l.trim())));
  });
}

let ask;
let closeInput;
if (process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  ask = (q, def) =>
    new Promise((res) => {
      const hint = def ? ` [recommended: ${def}]` : "";
      rl.question(`${q}${hint}\n> `, (a) => res(a.trim() || def));
    });
  closeInput = () => rl.close();
} else {
  // Piped answers (or empty pipe = all defaults); one line per question.
  const lines = await readStdinLines();
  let i = 0;
  ask = (q, def) => {
    const hint = def ? ` [recommended: ${def}]` : "";
    console.log(`${q}${hint}\n> ${lines[i] ?? ""}`);
    return Promise.resolve(lines[i++] || def);
  };
  closeInput = () => {};
}

const answers = {};
answers.canonical = await ask(
  "Q1 — Which files count as canonical for this refresh? (comma-separated, empty = recommended list)",
  DEFAULT_CANONICAL.join(", "),
);
answers.source = await ask(
  "Q2 — Where does the latest strategy/product truth live? (path to build plans or records)",
  "docs/build/v3/ (curated, scrubbed copy)",
);
answers.releaseFolder = await ask(
  "Q3 — Where should per-release folders live (plans, build plans, screenshots, release files by version)?",
  "docs/release/history/<version>/",
);
answers.archiveRule = await ask(
  "Q4 — Archive stale material instead of deleting it? (yes/no)",
  "yes",
);
answers.publishBoundary = await ask(
  "Q5 — May publishable strategy/product substance be committed after scrubbing, keeping portal and private material local? (yes/no)",
  "yes",
);
answers.githubParity = await ask(
  "Q6 — Apply the result both locally and on GitHub via branch, commit, and push? (yes/no)",
  "yes",
);
closeInput();

const body = `---
title: "Docs refresh plan (interview-generated)"
status: draft
date: ${today}
---

# Docs refresh plan (interview-generated)

> Status: **Draft** — produced for owner approval. No rewrites, moves, or pushes until approved.

## Goal

Unify the canonical files around the latest strategy and product decisions so
future builds reference one consistent story, locally and on GitHub.

## Source of truth

${answers.source}

## Canonical files

${answers.canonical
  .split(",")
  .map((f) => `- \`${f.trim()}\``)
  .join("\n")}

## Decisions

- Per-release folders: \`${answers.releaseFolder}\` (plans, build plans, screenshots per version; release files organized separately by version).
- Stale material: ${answers.archiveRule.toLowerCase().startsWith("y") ? "ARCHIVE to `docs/archive/` with a dated log; no deletions." : "owner chose deletion — list every deletion explicitly."}
- Publish boundary: ${answers.publishBoundary.toLowerCase().startsWith("y") ? "publishable substance committed after scrubbing; portal, customer-adjacent, and raw material stays local." : "keep everything local; owner will define the boundary."}
- GitHub parity: ${answers.githubParity.toLowerCase().startsWith("y") ? "land via branch, scoped commits, push; verify local main equals origin/main." : "local only."}

## Validation

- Interview output is exactly one new file; nothing else changed (\`git status --short --branch\`).
- Moved documents keep working inbound links, updated in the same change.
- Scrub review before committing: no credentials, customer rows, private contacts, or raw captures.
- After push: per-release folders visible on GitHub; local main equals origin/main.
`;
mkdirSync(join(outPath, ".."), { recursive: true });
let finalPath = outPath;
for (let i = 2; existsSync(finalPath); i++) {
  finalPath = outPath.replace(/\.md$/, `-${i}.md`);
}
writeFileSync(finalPath, body);
console.log(`\nWrote plan: ${finalPath}`);
console.log("Review it. Nothing else was changed.");
