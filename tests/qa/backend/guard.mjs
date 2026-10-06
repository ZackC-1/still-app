// Production-safety guard for the QA local backend (L8). Every entry point in tests/qa/backend calls
// these before doing anything. They refuse, by throwing LocalOnlyRefusal, whenever there is any sign
// that a command could reach a linked or hosted Supabase project:
//
//   * the checkout is linked (supabase/.temp/project-ref or another link marker exists);
//   * any SUPABASE_* variable is set (the CLI reads SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD,
//     SUPABASE_PROJECT_ID and config overrides from them);
//   * any environment value names a hosted Supabase address, or a database/API URL variable points
//     anywhere but this machine, DOCKER_HOST is not a unix socket or loopback address, or
//     DOCKER_CONTEXT is anything but unset, "default" or "orbstack";
//   * a Supabase CLI command is anything other than the three exact local shapes below.
//
// Background: STANDING-AGENT-RULES §3 and the 2026-10-05 incident, where a CLI command ran in the
// production-linked main checkout. Nothing here links, pushes or deploys, and nothing can be made to.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

export class LocalOnlyRefusal extends Error {
  constructor(reason) {
    super(`QA backend refused: ${reason}`);
    this.name = "LocalOnlyRefusal";
  }
}

/** Files the Supabase CLI writes when a directory is linked to a hosted project. */
export const LINK_MARKERS = Object.freeze([
  "supabase/.temp/project-ref",
  "supabase/.temp/pooler-url",
  "supabase/.temp/linked-project.json",
]);

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const HOSTED = /(?:^|[^a-z0-9])(?:[a-z0-9-]+\.)*supabase\.(?:co|com|in|net)(?![a-z0-9])/i;
const URLISH_NAME = /(SUPABASE|DATABASE|POSTGRES|PG|DB)[A-Z0-9_]*(URL|URI|HOST|ENDPOINT)$|^PGHOST$/;

/** True only for http(s) URLs on this machine. Anything unparsable is not local. */
export function isLocalUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (!["http:", "https:", "postgres:", "postgresql:"].includes(url.protocol)) return false;
  // Local database URLs carry the CLI's local demo credentials; a web URL never carries any.
  if ((url.protocol === "http:" || url.protocol === "https:") && (url.username || url.password)) return false;
  return LOCAL_HOSTS.has(url.hostname);
}

/** A Docker endpoint on this machine: a unix socket, or tcp to loopback. */
export function isLocalDockerHost(value) {
  const text = String(value).trim();
  if (/^unix:\/\/\/[^\s]+$/.test(text)) return true;
  try {
    const url = new URL(text);
    return url.protocol === "tcp:" && LOCAL_HOSTS.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Throws unless `value` is a local URL. */
export function assertLocalUrl(value, label = "URL") {
  if (!isLocalUrl(value)) throw new LocalOnlyRefusal(`${label} is not a localhost address`);
  return String(value);
}

/** Refuse when the checkout (or a mirror) carries any Supabase link marker. */
export function assertNotLinked(root) {
  for (const marker of LINK_MARKERS) {
    if (existsSync(join(root, marker))) {
      throw new LocalOnlyRefusal(`${marker} exists in ${root}: this checkout is linked to a hosted project`);
    }
  }
}

/** Refuse any environment that could point the CLI or a client at a hosted project. */
export function assertLocalEnv(env = process.env) {
  for (const [name, raw] of Object.entries(env)) {
    if (raw === undefined) continue;
    const value = String(raw);
    if (/^SUPABASE_/i.test(name)) {
      throw new LocalOnlyRefusal(`environment variable ${name} is set (unset every SUPABASE_* variable)`);
    }
    if (HOSTED.test(value)) {
      throw new LocalOnlyRefusal(`environment variable ${name} names a hosted Supabase address`);
    }
    if (name === "DOCKER_CONTEXT" && !["", "default", "orbstack"].includes(value.trim())) {
      throw new LocalOnlyRefusal(`DOCKER_CONTEXT "${value}" is not the local default or orbstack context`);
    }
    if (name === "DOCKER_HOST" && value.trim() !== "" && !isLocalDockerHost(value)) {
      throw new LocalOnlyRefusal("DOCKER_HOST is not a unix socket or loopback address");
    }
    if (URLISH_NAME.test(name.toUpperCase()) && value.trim() !== "") {
      const local = isLocalUrl(value) || LOCAL_HOSTS.has(value.trim());
      if (!local) throw new LocalOnlyRefusal(`environment variable ${name} is not a localhost address`);
    }
  }
}

const FORBIDDEN_TOKENS = new Set([
  "link", "unlink", "login", "logout", "push", "pull", "deploy", "secrets", "projects", "orgs",
  "branches", "--linked", "--project-ref", "--db-url", "--all", "--password", "-p", "inspect",
  "db", "functions", "migration", "migrations", "seed", "gen", "storage", "sso", "domains",
]);

/** The only Supabase CLI invocations this recipe may make. `workdir` is the QA mirror. */
export function allowedCliShapes(workdir, exclude) {
  return [
    ["start", "--workdir", workdir, "--exclude", exclude],
    ["status", "--workdir", workdir, "-o", "json"],
    ["stop", "--workdir", workdir, "--no-backup"],
  ];
}

/** Throw unless `args` is exactly one of the allowed shapes and contains no forbidden token. */
export function assertAllowedCli(args, workdir, exclude) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) {
    throw new LocalOnlyRefusal("CLI arguments must be a list of strings");
  }
  const bad = args.find(arg => FORBIDDEN_TOKENS.has(arg) || /^--(db-url|project-ref|linked)=/.test(arg));
  if (bad) throw new LocalOnlyRefusal(`CLI argument "${bad}" is never allowed`);
  const ok = allowedCliShapes(workdir, exclude).some(shape =>
    shape.length === args.length && shape.every((part, i) => part === args[i]));
  if (!ok) throw new LocalOnlyRefusal(`CLI command "supabase ${args.join(" ")}" is not one of the allowed local shapes`);
  return args;
}

/** The disposable local password of the QA stack's settings-writer role (sync-settings connects as it). */
export const QA_WRITER_PASSWORD = "qa-local-writer-only";
/** The one SQL statement the recipe runs inside the QA database container. */
export const WRITER_LOGIN_SQL = `alter role still_settings_writer login password '${QA_WRITER_PASSWORD}'`;

/** The one docker command the recipe runs besides the read-only listings: psql inside THIS mirror's
 * own database container (supabase_db_<its project id>), never any other container. */
export function writerLoginArgs(mirror) {
  const id = basename(String(mirror).replace(/\/+$/, ""));
  return ["exec", "-i", `supabase_db_${id}`, "psql", "-U", "supabase_admin", "-d", "postgres", "-X", "--set=ON_ERROR_STOP=1", "-c", WRITER_LOGIN_SQL];
}

/** Throw unless `args` is exactly the writer-login command for the QA mirror `mirror`. */
export function assertAllowedDocker(args, mirror) {
  const id = basename(String(mirror).replace(/\/+$/, ""));
  if (!/^still-qa-[a-z0-9-]{1,60}$/.test(id)) throw new LocalOnlyRefusal(`mirror name ${id} is not a QA project id`);
  const want = writerLoginArgs(mirror);
  const ok = Array.isArray(args) && args.length === want.length && want.every((part, i) => part === args[i]);
  if (!ok) throw new LocalOnlyRefusal(`docker command "docker ${Array.isArray(args) ? args.join(" ") : ""}" is not the QA writer-login shape`);
  return args;
}

/** One call for every entry point: not linked, local environment. */
export function assertLocalOnly({ root, env = process.env }) {
  assertNotLinked(root);
  assertLocalEnv(env);
}
