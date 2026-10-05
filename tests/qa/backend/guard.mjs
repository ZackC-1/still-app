// Production-safety guard for the QA local backend (L8). Every entry point in tests/qa/backend calls
// these before doing anything. They refuse, by throwing LocalOnlyRefusal, whenever there is any sign
// that a command could reach a linked or hosted Supabase project:
//
//   * the checkout is linked (supabase/.temp/project-ref or another link marker exists);
//   * any SUPABASE_* variable is set (the CLI reads SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD,
//     SUPABASE_PROJECT_ID and config overrides from them);
//   * any environment value names a hosted Supabase address, or a database/API URL variable points
//     anywhere but this machine, or DOCKER_HOST is not a unix socket or loopback address;
//   * a Supabase CLI command is anything other than the three exact local shapes below.
//
// Background: STANDING-AGENT-RULES §3 and the 2026-10-05 incident, where a CLI command ran in the
// production-linked main checkout. Nothing here links, pushes or deploys, and nothing can be made to.
import { existsSync } from "node:fs";
import { join } from "node:path";

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

/** One call for every entry point: not linked, local environment. */
export function assertLocalOnly({ root, env = process.env }) {
  assertNotLinked(root);
  assertLocalEnv(env);
}
