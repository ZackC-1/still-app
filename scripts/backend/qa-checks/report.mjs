// Privacy-safe rendering for read-only QA check results.
//
// The full report is only ever written ENCRYPTED (run.ts); the public log shows a verdict line.
// Even so, every value passes a declared type: counts, numbers, booleans, closed states,
// timestamps, catalog names, settings switch maps, version strings, truncated fingerprints, and
// keyed short references in place of raw ids. Anything else (an email, token, raw id, free text
// or an unexpected shape) is replaced by "<withheld>" and counted, never printed.
import { createHmac } from "node:crypto";
import { LABELS } from "./catalogue.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const NAME = /^(PUBLIC|[a-z_][a-z0-9_]{0,62})$/;
/** An id or digest hiding in a "name": a UUID fragment or a long hex run is never printed. */
const IDENTITY_LIKE = /[0-9a-f]{8}-?[0-9a-f]{4}|[0-9a-f]{16,}/i;
const keyLike = (value) => typeof value === "string" && KEY.test(value) && !IDENTITY_LIKE.test(value);
export const WITHHELD = "<withheld>";

/**
 * A short reference for an id: "#" + 10 hex of HMAC-SHA-256 under the environment's reference key.
 * Stable across runs (same key), so Claude can match a right before and after an action, but not
 * linkable to the id without the key.
 */
export function ref(id, refKey) {
  if (typeof refKey !== "string" || !/^[0-9a-f]{64}$/.test(refKey)) throw new Error("Reference key missing or malformed");
  return `#${createHmac("sha256", Buffer.from(refKey, "hex")).update(String(id).toLowerCase()).digest("hex").slice(0, 10)}`;
}

function integer(value, { min = 0 } = {}) {
  const text = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^-?[0-9]{1,16}$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= min ? String(n) : undefined;
}

function timestamp(value) {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Formats one value by its declared type; returns WITHHELD when it does not fit. */
export function formatValue(value, type, { refKey } = {}) {
  if (value === null || value === undefined) return "none";
  const kind = typeof type === "string" ? type : type.type;
  let out;
  switch (kind) {
    case "count":
      out = integer(value);
      break;
    case "number":
      out = integer(value, { min: -1 });
      break;
    case "bool":
      out = value === true ? "yes" : value === false ? "no" : undefined;
      break;
    case "timestamp":
      out = timestamp(value);
      break;
    case "ref":
      out = typeof value === "string" && UUID.test(value) ? ref(value, refKey) : undefined;
      break;
    case "version":
      out = typeof value === "string" && /^[0-9]{1,20}$/.test(value) ? value : undefined;
      break;
    case "fingerprint":
      out = typeof value === "string" && /^[0-9a-f]{32}$/.test(value) ? value.slice(0, 16) : undefined;
      break;
    case "state":
      out = type.values.includes(value) ? value : undefined;
      break;
    case "label":
      out = typeof value === "string" && Object.hasOwn(LABELS, value) ? `${LABELS[value]} (${value})` : undefined;
      break;
    case "key":
      out = keyLike(value) ? value : undefined;
      break;
    case "name":
      out = typeof value === "string" && NAME.test(value) && !IDENTITY_LIKE.test(value) ? value : undefined;
      break;
    case "switches": {
      if (typeof value !== "object" || Array.isArray(value)) break;
      const entries = Object.entries(value);
      if (entries.length > 64 || entries.some(([k, v]) => !keyLike(k) || typeof v !== "boolean")) break;
      out = entries.length
        ? entries
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, v]) => `${k}=${v ? "on" : "off"}`)
            .join(", ")
        : "(empty)";
      break;
    }
    default:
      throw new Error(`Unknown field type ${kind}`);
  }
  return out ?? WITHHELD;
}

const cell = (text) => text.replace(/\|/g, "/");

/** Renders the rows of one query as a Markdown table using only its declared fields. */
export function renderQuery(query, rows, options = {}) {
  const columns = Object.keys(query.fields);
  let withheld = 0;
  const lines = [`### ${query.name}`, ""];
  if (rows.length === 0) return { text: [...lines, "(no rows)", ""].join("\n"), withheld };
  lines.push(`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`);
  for (const row of rows.slice(0, 50)) {
    const values = columns.map((c) => {
      const text = formatValue(row[c], query.fields[c], options);
      if (text === WITHHELD) withheld++;
      return cell(text);
    });
    lines.push(`| ${values.join(" | ")} |`);
  }
  if (rows.length > 50) lines.push("", `(${rows.length - 50} more rows not shown)`);
  return { text: [...lines, ""].join("\n"), withheld };
}

const PRODUCTION_TEXT = {
  recorded: "baseline recorded (keyed digest only; production values are never printed)",
  unchanged: "yes",
  changed: "NO: production rights, policy revisions or cutoff changed since the DB-01 baseline",
  "no-baseline": "unknown: no successful DB-01 baseline run was found",
};

/**
 * The full report for one run (encrypted before it leaves the runner).
 * @param {{ programId: string, check: any, labels: string[], holders: string[], results: any[], refKey: string, production?: string, verdict: string, notes?: string[] }} input
 */
export function renderReport({ programId, check, labels, holders, results, refKey, production, verdict, notes = [] }) {
  let withheld = 0;
  const sections = results.map(({ query, rows }) => {
    const rendered = renderQuery(query, rows, { refKey });
    withheld += rendered.withheld;
    return rendered.text;
  });
  const accounts = labels.length
    ? labels.map((label, i) => `${LABELS[label]} (${ref(holders[i], refKey)})`).join(" and ")
    : "none (whole-database or QA-registry check)";
  return [
    `## Read-only QA check ${programId}: ${check.title}`,
    "",
    `- Verdict: ${verdict}`,
    `- Catalogue check: \`${check.id}\`${check.programIds.length ? ` (answers ${check.programIds.join(", ")})` : ""}`,
    `- QA account(s): ${accounts}`,
    `- Expected (from the programme): ${check.expected}`,
    ...(production ? [`- Production unchanged since baseline: ${PRODUCTION_TEXT[production]}`] : []),
    ...notes.map((note) => `- Note: ${note}`),
    "- Session: narrow read-only role, read-only transaction, rolled back. References are keyed short hashes, never raw ids.",
    ...(withheld ? [`- ${withheld} value(s) withheld because they did not match the expected shape.`] : []),
    "",
    ...sections,
  ].join("\n");
}
