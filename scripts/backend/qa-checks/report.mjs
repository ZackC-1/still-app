// Privacy-safe rendering for read-only QA check results.
//
// Every printed value passes a declared type: counts, numbers, booleans, closed states,
// timestamps, catalog names, settings switch maps, version strings, truncated fingerprints, and
// short hashed references in place of raw ids. Anything else (an email, token, raw id, free text
// or an unexpected shape) is replaced by "<withheld>" and counted, never printed.
import { createHash } from "node:crypto";
import { LABELS } from "./catalogue.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const NAME = /^(PUBLIC|[a-z_][a-z0-9_]{0,62})$/;
/** An id or digest hiding in a "name": a UUID fragment or a long hex run is never printed. */
const IDENTITY_LIKE = /[0-9a-f]{8}-?[0-9a-f]{4}|[0-9a-f]{16,}/i;
const keyLike = (value) => typeof value === "string" && KEY.test(value) && !IDENTITY_LIKE.test(value);
export const WITHHELD = "<withheld>";

/** A short, stable, non-reversible reference for an id: "#" + 10 hex of its SHA-256. */
export function ref(id) {
  return `#${createHash("sha256").update(String(id).toLowerCase()).digest("hex").slice(0, 10)}`;
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
export function formatValue(value, type) {
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
      out = typeof value === "string" && UUID.test(value) ? ref(value) : undefined;
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
export function renderQuery(query, rows) {
  const columns = Object.keys(query.fields);
  let withheld = 0;
  const lines = [`### ${query.name}`, ""];
  if (rows.length === 0) return { text: [...lines, "(no rows)", ""].join("\n"), withheld };
  lines.push(`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`);
  for (const row of rows.slice(0, 50)) {
    const values = columns.map((c) => {
      const text = formatValue(row[c], query.fields[c]);
      if (text === WITHHELD) withheld++;
      return cell(text);
    });
    lines.push(`| ${values.join(" | ")} |`);
  }
  if (rows.length > 50) lines.push("", `(${rows.length - 50} more rows not shown)`);
  return { text: [...lines, ""].join("\n"), withheld };
}

/** The full report for one run. `results` pairs each catalogue query with its rows. */
export function renderReport({ programId, check, labels, holders, results }) {
  let withheld = 0;
  const sections = results.map(({ query, rows }) => {
    const rendered = renderQuery(query, rows);
    withheld += rendered.withheld;
    return rendered.text;
  });
  const accounts = labels.length
    ? labels.map((label, i) => `${LABELS[label]} (${ref(holders[i])})`).join(" and ")
    : "none (whole-database or QA-registry check)";
  return [
    `## Read-only QA check ${programId}: ${check.title}`,
    "",
    `- Catalogue check: \`${check.id}\`${check.programIds.length ? ` (answers ${check.programIds.join(", ")})` : ""}`,
    `- QA account(s): ${accounts}`,
    `- Expected (from the programme): ${check.expected}`,
    "- Session: narrow read-only role, read-only transaction, rolled back. References are short hashes, never raw ids.",
    ...(withheld ? [`- ${withheld} value(s) withheld because they did not match the expected shape.`] : []),
    "",
    ...sections,
  ].join("\n");
}
