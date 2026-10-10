// Allow-list guard for the read-only QA check catalogue (catalogue.mjs).
//
// A catalogue query passes only if it is exactly one plain SELECT that
// - has no statement separator, comment, dollar quoting, double-quoted identifier, backslash or
//   prefixed string (E'', U&'', B'', X''), so nothing can hide a second statement or escape;
// - contains none of the words that write, lock, change settings or control transactions;
// - reads only the granted still_qa_checks views and a few pg_catalog catalog relations;
// - calls only allow-listed, side-effect-free functions; and
// - uses only the positional parameters $1..$2 that the check declares.
// The database enforces the same boundary independently (read-only role and transaction, server
// binds that refuse more than one statement); this guard keeps reviewed source honest.

/** The only relations a catalogue query may read (each is granted SELECT in the candidate SQL). */
export const CHECK_VIEWS = Object.freeze([
  "account_status",
  "qa_subjects",
  "profiles",
  "settings_writes_summary",
  "settings_anchors",
  "entitlements_summary",
  "access_rights",
  "apple_observations",
  "access_observations",
  "access_revocations",
  "apple_link_operations",
  "purchase_operations",
  "negative_rights",
  "sessions_summary",
  "rate_limit_summary",
  "analytics_subjects_summary",
  "migration_history",
  "policy_heads",
  "paid_cutoff_environments",
  "production_rights_fingerprint",
  "rights_summary",
  "isolation_summary",
  "retention_summary",
  "privacy_summary",
  "erasure_jobs_last_hour",
]);
const CATALOG_RELATIONS = new Set([
  "pg_class",
  "pg_namespace",
  "pg_attribute",
  "pg_proc",
]);
/** Pure functions only: no sequence, advisory lock, file, network, sleep or setting access. */
const FUNCTIONS = new Set([
  "count",
  "sum",
  "max",
  "min",
  "coalesce",
  "md5",
  "to_timestamp",
  "now",
  "jsonb_each",
  "aclexplode",
  "acldefault",
  "pg_get_userbyid",
]);
/** Words that may legitimately be followed by "(" without being a function call. */
const PAREN_KEYWORDS = new Set([
  "select",
  "from",
  "where",
  "and",
  "or",
  "not",
  "in",
  "exists",
  "filter",
  "join",
  "lateral",
  "on",
  "as",
  "then",
  "else",
  "when",
  "is",
  "by",
  "distinct",
]);
const FORBIDDEN = new Set(
  (
    "insert update delete merge truncate copy grant revoke alter create drop call do set reset " +
    "lock listen notify unlisten vacuum analyze analyse cluster reindex refresh security definer " +
    "execute prepare deallocate discard begin start commit rollback abort savepoint " +
    "release into for returning comment import load checkpoint declare fetch move close explain " +
    "table values with recursive nowait skip share union intersect except over window"
  ).split(" "),
);
/** Schemas a query must never name. Only still_qa_checks and pg_catalog are readable. */
const OTHER_SCHEMAS = new Set([
  "public",
  "private",
  "auth",
  "storage",
  "extensions",
  "supabase_migrations",
  "cron",
  "vault",
  "net",
  "graphql",
  "graphql_public",
  "realtime",
  "pgsodium",
  "pgbouncer",
  "supabase_functions",
  "information_schema",
  "pg_toast",
  "still_security",
]);

export class GuardError extends Error {}

function tokenize(sql) {
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'") {
      const prev = tokens.at(-1);
      if (prev && prev.end === i && (prev.type === "word" || prev.type === "number"))
        throw new GuardError("prefixed string literal");
      let j = i + 1;
      while (j < sql.length && sql[j] !== "'") j++;
      if (j >= sql.length) throw new GuardError("unterminated string literal");
      if (sql[j + 1] === "'") throw new GuardError("escaped quote in literal");
      tokens.push({ type: "string", value: sql.slice(i + 1, j), end: j + 1 });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      tokens.push({ type: "word", value: sql.slice(i, j).toLowerCase(), end: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[0-9.]/.test(sql[j])) j++;
      tokens.push({ type: "number", value: sql.slice(i, j), end: j });
      i = j;
      continue;
    }
    if (ch === "$") {
      const match = /^\$([1-9])(?![0-9A-Za-z_$])/.exec(sql.slice(i));
      if (!match) throw new GuardError("dollar quoting or bad parameter");
      tokens.push({ type: "param", value: Number(match[1]), end: i + 2 });
      i += 2;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") throw new GuardError("comment");
    if (ch === "/" && sql[i + 1] === "*") throw new GuardError("comment");
    if (";\"\\`{}[]".includes(ch))
      throw new GuardError(`forbidden character ${JSON.stringify(ch)}`);
    if (!"(),.*=<>!~+-/%:|".includes(ch))
      throw new GuardError(`unexpected character ${JSON.stringify(ch)}`);
    tokens.push({ type: "punct", value: ch, end: i + 1 });
    i++;
  }
  return tokens;
}

/**
 * Throws GuardError unless `sql` is one allow-listed SELECT using at most `paramCount`
 * positional parameters. Returns the set of still_qa_checks views it reads.
 */
export function assertSingleSelect(sql, paramCount = 0) {
  if (typeof sql !== "string" || sql.length === 0 || sql.length > 4000)
    throw new GuardError("query missing or too long");
  if (!/^[\x20-\x7e\n]*$/.test(sql)) throw new GuardError("non-ASCII or control character");
  const tokens = tokenize(sql);
  if (tokens[0]?.type !== "word" || tokens[0].value !== "select")
    throw new GuardError("query must start with SELECT");
  let depth = 0;
  const views = new Set();
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const next = tokens[k + 1];
    if (t.type === "punct" && t.value === "(") depth++;
    if (t.type === "punct" && t.value === ")" && --depth < 0)
      throw new GuardError("unbalanced parentheses");
    if (t.type === "param" && t.value > paramCount)
      throw new GuardError(`undeclared parameter $${t.value}`);
    if (t.type !== "word") continue;
    if (FORBIDDEN.has(t.value)) throw new GuardError(`forbidden word ${t.value}`);
    const qualified = next?.type === "punct" && next.value === "." && tokens[k + 2]?.type === "word";
    if (qualified) {
      const member = tokens[k + 2].value;
      if (OTHER_SCHEMAS.has(t.value)) throw new GuardError(`schema ${t.value} is not readable`);
      if (t.value === "still_qa_checks") {
        if (!CHECK_VIEWS.includes(member)) throw new GuardError(`unknown view ${member}`);
        views.add(member);
      }
      if (t.value === "pg_catalog") {
        const call = tokens[k + 3]?.type === "punct" && tokens[k + 3].value === "(";
        if (call ? !FUNCTIONS.has(member) : !CATALOG_RELATIONS.has(member))
          throw new GuardError(`pg_catalog.${member} is not allowed`);
      }
      k += 2;
      continue;
    }
    const prev = tokens[k - 1];
    const isMember = prev?.type === "punct" && prev.value === ".";
    if (!isMember && next?.type === "punct" && next.value === "(" && !PAREN_KEYWORDS.has(t.value) && !FUNCTIONS.has(t.value))
      throw new GuardError(`function ${t.value} is not allowed`);
    if (t.value === "from" || t.value === "join") {
      const target = next?.type === "word" ? next.value : next?.value;
      if (!["still_qa_checks", "pg_catalog", "(", "lateral"].includes(target))
        throw new GuardError(`${t.value} must name a check view or catalog relation`);
    }
  }
  if (depth !== 0) throw new GuardError("unbalanced parentheses");
  return views;
}
