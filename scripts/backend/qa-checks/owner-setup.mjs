// One-time owner helpers for the read-only QA check route. Both run on the owner's computer,
// make no network call and never print a password or an email.
//
//   node scripts/backend/qa-checks/owner-setup.mjs login --project-ref <ref> --pooler-host <host> --out <new private file>
//     Generates a random password in memory and writes ONE private file (mode 0600, refuses to
//     overwrite) holding: the SQL-editor statement that enables sign-in for
//     still_qa_readonly_checker with a SCRAM-SHA-256 verifier (the password itself never reaches
//     the database or its logs), and the session-pooler URL for the GitHub environment secret
//     STILL_QA_READONLY_DB_URL. Delete the file after both are pasted.
//
//   node scripts/backend/qa-checks/owner-setup.mjs registry < <private JSON {"qa-a": "<email>", ...}>
//     Prints the SQL-editor statement that registers the nine QA labels. It carries only SHA-256
//     digests of the lower-cased emails; the database matches them against Auth itself.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { generatePassword, scramSha256Verifier } from "../deploy/qa-secrets.mjs";
import { LABELS } from "./catalogue.mjs";

const ROLE = "still_qa_readonly_checker";
const EMAIL = /^[^\s@'"\\]{1,64}@[^\s@'"\\]{1,190}\.[A-Za-z]{2,24}$/;

export function loginArtifacts({ projectRef, poolerHost, password = generatePassword() }) {
  if (!/^[a-z]{20}$/.test(projectRef ?? "")) throw new Error("--project-ref must be the 20-letter project ref");
  if (!/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(poolerHost ?? ""))
    throw new Error("--pooler-host must be the session pooler host from the Supabase Connect panel");
  const verifier = scramSha256Verifier(password);
  return [
    "-- 1. Paste into the Supabase SQL editor (a SCRAM verifier only; no password):",
    `alter role ${ROLE} with login password '${verifier}';`,
    "",
    "-- 2. GitHub > Settings > Environments > supabase-readonly-checks > secret STILL_QA_READONLY_DB_URL:",
    `postgresql://${ROLE}.${projectRef}:${password}@${poolerHost}:5432/postgres?sslmode=verify-full`,
    "",
    "-- 3. Delete this file.",
    "",
  ].join("\n");
}

export function registrySql(accounts) {
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) throw new Error("Expected one JSON object");
  const labels = Object.keys(accounts);
  const unknown = labels.filter((l) => !Object.hasOwn(LABELS, l));
  if (unknown.length) throw new Error(`Unknown labels (use ${Object.keys(LABELS).join(", ")})`);
  if (labels.length !== Object.keys(LABELS).length) throw new Error("All nine QA labels are required");
  const digests = labels.map((label) => {
    const email = accounts[label];
    if (typeof email !== "string" || !EMAIL.test(email.trim())) throw new Error(`Label ${label} needs one email address`);
    return [label, createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex")];
  });
  if (new Set(digests.map(([, d]) => d)).size !== digests.length) throw new Error("Each label needs a different email");
  return [
    "-- Registers the nine QA labels for the read-only check route. Only email digests appear here.",
    "insert into still_qa_checks.qa_accounts(label, holder)",
    "select v.label, u.id from (values",
    digests.map(([label, digest]) => `  ('${label}', '${digest}')`).join(",\n"),
    ") v(label, email_sha256)",
    "join auth.users u on pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.lower(u.email), 'UTF8')), 'hex') = v.email_sha256",
    "on conflict (label) do update set holder = excluded.holder, registered_at = pg_catalog.clock_timestamp();",
    "-- Expect 9. Fewer means an email matched no account; nothing else changed.",
    "select pg_catalog.count(*) as registered_labels from still_qa_checks.qa_accounts;",
    "",
  ].join("\n");
}

const option = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "login") {
      const out = option(args, "--out");
      if (!out) throw new Error("--out <new private file> is required");
      const text = loginArtifacts({ projectRef: option(args, "--project-ref"), poolerHost: option(args, "--pooler-host") });
      await writeFile(out, text, { mode: 0o600, flag: "wx" });
      console.log(`Wrote ${out} (owner-only). Paste step 1 and step 2, then delete it.`);
    } else if (command === "registry") {
      process.stdout.write(registrySql(JSON.parse(await readStdin())));
    } else {
      throw new Error("Use: login --project-ref <ref> --pooler-host <host> --out <file> | registry < accounts.json");
    }
  } catch (error) {
    console.error(error instanceof SyntaxError ? "The input is not valid JSON." : error.message);
    process.exitCode = 1;
  }
}
