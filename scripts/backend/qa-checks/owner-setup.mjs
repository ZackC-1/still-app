// One-time owner helpers for the read-only QA check route. Both run on the owner's computer,
// make no network call and never print a password or an email.
//
//   node scripts/backend/qa-checks/owner-setup.mjs login --project-ref <ref> --pooler-host <host> --out <new private file>
//     Generates a random password and a random reference key in memory and writes ONE private file
//     (mode 0600, refuses to overwrite) holding: the SQL-editor statement that enables sign-in for
//     still_qa_readonly_checker for 60 days with a SCRAM-SHA-256 verifier (the password itself
//     never reaches the database or its logs), and the two GitHub environment secrets
//     STILL_QA_READONLY_DB_URL and STILL_QA_READONLY_REF_KEY. Delete the file after pasting.
//
//   node scripts/backend/qa-checks/owner-setup.mjs registry < <private JSON {"qa-a": "<email>", ...}>
//     Prints two SQL-editor blocks: a read-only PREVIEW that shows the owner, in the SQL editor
//     only, each label with a masked address (z***+stillqa-refund@…) and whether it is a confirmed
//     owner QA alias; then the COMMIT block, to run only if every previewed row is. The eight alias
//     labels are required; `preserved` (an older, non-alias account) is optional and is left out
//     with a note when it is absent or not a +stillqa alias, because the database refuses it. Both carry only SHA-256
//     digests (of each lower-cased email and of the tag-free base mailbox). These digests are not
//     secret, just not readable at a glance; the database enforces the alias rule itself.
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { generatePassword, scramSha256Verifier } from "../deploy/qa-secrets.mjs";
import { LABELS, OPTIONAL_LABELS, REQUIRED_LABELS } from "./catalogue.mjs";

const ROLE = "still_qa_readonly_checker";
const EMAIL = /^[^\s@'"\\]{1,64}@[^\s@'"\\]{1,190}\.[A-Za-z]{2,24}$/;
/** Same rule as the candidate SQL: <base local part>+stillqa-<name>@<base domain>. */
export const QA_ALIAS = /^[^+@]+\+stillqa-[a-z0-9-]+@[^@]+$/;
const TAG = /\+stillqa-[a-z0-9-]+@/;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const ALIAS_SQL = (base) =>
  "u.email_confirmed_at is not null and pg_catalog.lower(u.email) ~ '^[^+@]+\\+stillqa-[a-z0-9-]+@[^@]+$' " +
  "and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.regexp_replace(pg_catalog.lower(u.email), '\\+stillqa-[a-z0-9-]+@', '@'), 'UTF8')), 'hex') " +
  `= '${base}'`;

export function loginArtifacts({
  projectRef,
  poolerHost,
  password = generatePassword(),
  refKey = randomBytes(32).toString("hex"),
  validUntil = new Date(Date.now() + 60 * 86400000),
}) {
  if (!/^[a-z]{20}$/.test(projectRef ?? "")) throw new Error("--project-ref must be the 20-letter project ref");
  if (!/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(poolerHost ?? ""))
    throw new Error("--pooler-host must be the session pooler host from the Supabase Connect panel");
  if (!/^[0-9a-f]{64}$/.test(refKey)) throw new Error("reference key must be 64 hex characters");
  const verifier = scramSha256Verifier(password);
  const until = validUntil.toISOString().slice(0, 10);
  return [
    `-- 1. Paste into the Supabase SQL editor (a SCRAM verifier only; no password). Sign-in expires ${until}:`,
    `alter role ${ROLE} with login password '${verifier}' valid until '${until}';`,
    "",
    "-- 2. GitHub > Settings > Environments > supabase-readonly-checks > secret STILL_QA_READONLY_DB_URL:",
    `postgresql://${ROLE}.${projectRef}:${password}@${poolerHost}:5432/postgres?sslmode=verify-full`,
    "",
    "-- 3. Same environment > secret STILL_QA_READONLY_REF_KEY:",
    refKey,
    "",
    "-- 4. Delete this file.",
    "",
  ].join("\n");
}

export function registrySql(accounts) {
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) throw new Error("Expected one JSON object");
  const labels = Object.keys(accounts);
  const unknown = labels.filter((l) => !Object.hasOwn(LABELS, l));
  if (unknown.length) throw new Error(`Unknown labels (use ${Object.keys(LABELS).join(", ")})`);
  const missing = REQUIRED_LABELS.filter((l) => !labels.includes(l));
  if (missing.length) throw new Error(`The eight QA alias labels are required; missing: ${missing.join(", ")}`);
  const skipped = [];
  const rows = [];
  for (const label of Object.keys(LABELS).filter((l) => labels.includes(l))) {
    const raw = accounts[label];
    const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!EMAIL.test(email)) throw new Error(`Label ${label} needs one email address`);
    if (!QA_ALIAS.test(email)) {
      if (OPTIONAL_LABELS.includes(label)) {
        skipped.push(label);
        continue;
      }
      throw new Error(`Label ${label} is not a +stillqa-<name> alias`);
    }
    rows.push({ label, digest: sha256(email), base: sha256(email.replace(TAG, "@")) });
  }
  for (const label of OPTIONAL_LABELS) if (!labels.includes(label)) skipped.push(label);
  if (new Set(rows.map((r) => r.digest)).size !== rows.length) throw new Error("Each label needs a different email");
  if (new Set(rows.map((r) => r.base)).size !== 1) throw new Error("All QA aliases must belong to the same mailbox");
  const notes = skipped.map(
    (l) => `-- ${l}: left out (not a +stillqa alias; the database would refuse it). Checks naming it answer "unavailable".`,
  );
  const base = rows[0].base;
  const values = rows.map((r) => `  ('${r.label}', '${r.digest}')`).join(",\n");
  const join = "join auth.users u on pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.lower(u.email), 'UTF8')), 'hex') = v.email_sha256";
  return [
    ...notes,
    `-- A. PREVIEW (reads only). Every one of the ${rows.length} rows must show qa_alias = true and a masked`,
    "--    address you recognise. If not, stop: do not run block B.",
    "select v.label,",
    "  pg_catalog.left(u.email, 1) || '***' || coalesce(pg_catalog.substring(pg_catalog.lower(u.email), '(\\+stillqa-[a-z0-9-]+)@'), '') || '@…' as masked_email,",
    `  coalesce(${ALIAS_SQL(base)}, false) as qa_alias`,
    "from (values",
    values,
    ") v(label, email_sha256)",
    `left ${join}`,
    "order by v.label;",
    "",
    `-- B. COMMIT (run separately, only after A shows ${rows.length} qa_alias = true rows).`,
    "begin;",
    "insert into still_qa_checks.qa_alias_owner(base_sha256)",
    `values ('${base}') on conflict (singleton) do update set base_sha256 = excluded.base_sha256;`,
    "insert into still_qa_checks.qa_accounts(label, holder)",
    "select v.label, u.id from (values",
    values,
    ") v(label, email_sha256)",
    join,
    "on conflict (label) do update set holder = excluded.holder, registered_at = pg_catalog.clock_timestamp();",
    `-- Expect ${rows.length}.`,
    "select pg_catalog.count(*) as registered_labels from still_qa_checks.qa_accounts;",
    "commit;",
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
      const sql = registrySql(JSON.parse(await readStdin()));
      for (const note of sql.split("\n").filter((l) => / left out /.test(l))) console.error(note.replace(/^-- /, "Note: "));
      process.stdout.write(sql);
    } else {
      throw new Error("Use: login --project-ref <ref> --pooler-host <host> --out <file> | registry < accounts.json");
    }
  } catch (error) {
    console.error(error instanceof SyntaxError ? "The input is not valid JSON." : error.message);
    process.exitCode = 1;
  }
}
