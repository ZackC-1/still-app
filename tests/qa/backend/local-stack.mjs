// The QA local Supabase stack (L8): a disposable mirror of this checkout's supabase/ project, started
// under its own project id ("still-qa") so its containers and volumes are unmistakably the QA stack's,
// with a QA-only sign-in email template that shows the one-time code. The repository's own
// supabase/config.toml is never edited.
//
// The mirror holds:
//   supabase/config.toml        copied, project_id rewritten to "still-qa", QA email templates added
//   supabase/migrations/**      copied
//   supabase/functions/**       copied (Edge Functions are served from the mirror)
//   supabase/templates/qa-code.html
//   packages/core/src/**, packages/shared-types/{src,fixtures}/**
//                               copied, because functions import them by relative path
//
// Only three Supabase CLI commands ever run, each checked by guard.assertAllowedCli:
//   supabase start  --workdir <mirror> --exclude <services QA does not need>
//   supabase status --workdir <mirror> -o json
//   supabase stop   --workdir <mirror> --no-backup
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAllowedCli, assertLocalOnly, assertLocalUrl, assertNotLinked, LocalOnlyRefusal } from "./guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../../..");
export const QA_PROJECT_ID = "still-qa";
export const DEFAULT_MIRROR = "/private/tmp/still-qa-backend";
/** Services QA never needs. Auth (gotrue), the API gateway, PostgREST, Edge Functions and Mailpit stay. */
export const EXCLUDE = "studio,imgproxy,logflare,vector,realtime,storage-api,supavisor,postgres-meta";
export const MIN_FREE_BYTES = 10 * 1024 ** 3;
const TEMPLATE = join(HERE, "templates/qa-code.html");

/** The QA-only email template tables appended to the mirror's config. */
export const QA_TEMPLATE_TOML = `
# --- QA mirror only (tests/qa/backend). Never present in the repository's config. ---
[auth.email.template.magic_link]
subject = "Still QA sign-in code"
content_path = "./supabase/templates/qa-code.html"

[auth.email.template.confirmation]
subject = "Still QA sign-in code"
content_path = "./supabase/templates/qa-code.html"
`;

/** Rewrite the copied config: exactly one project_id line, no pre-existing template tables. */
export function qaConfig(source) {
  const lines = source.split("\n");
  const ids = lines.filter(line => /^project_id\s*=/.test(line));
  if (ids.length !== 1) throw new LocalOnlyRefusal("config.toml must have exactly one project_id line");
  if (/^\[auth\.email\.template\.(magic_link|confirmation)\]/m.test(source)) {
    throw new LocalOnlyRefusal("config.toml already defines a sign-in email template; the QA mirror will not override it");
  }
  return lines.map(line => /^project_id\s*=/.test(line) ? `project_id = "${QA_PROJECT_ID}"` : line).join("\n") + QA_TEMPLATE_TOML;
}

/** Build (or rebuild) the mirror from `root`. */
export function buildMirror({ root = REPO, mirror = DEFAULT_MIRROR } = {}) {
  assertNotLinked(root);
  if (resolve(mirror) === resolve(root) || resolve(mirror).startsWith(resolve(root) + "/")) {
    throw new LocalOnlyRefusal("the mirror must live outside the checkout");
  }
  rmSync(mirror, { recursive: true, force: true });
  const copy = (from, to = from) => cpSync(join(root, from), join(mirror, to), {
    recursive: true,
    filter: path => !/\/(\.temp|\.branches|node_modules)(\/|$)/.test(path) && !/\/\.env(\.|$)/.test(path),
  });
  for (const part of ["supabase/migrations", "supabase/functions", "packages/core/src", "packages/shared-types/src", "packages/shared-types/fixtures"]) {
    copy(part);
  }
  mkdirSync(join(mirror, "supabase/templates"), { recursive: true });
  cpSync(TEMPLATE, join(mirror, "supabase/templates/qa-code.html"));
  writeFileSync(join(mirror, "supabase/config.toml"), qaConfig(readFileSync(join(root, "supabase/config.toml"), "utf8")));
  assertNotLinked(mirror);
  return mirror;
}

/** Run one allowed Supabase CLI command with a scrubbed environment. */
export function runCli(args, { mirror = DEFAULT_MIRROR, env = process.env, spawn = spawnSync } = {}) {
  assertAllowedCli(args, mirror, EXCLUDE);
  assertNotLinked(mirror);
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !/^SUPABASE_/i.test(name)));
  const result = spawn("supabase", args, { cwd: mirror, env: clean, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`supabase ${args[0]} failed (${result.status}): ${String(result.stderr ?? "").trim().slice(-800)}`);
  }
  return String(result.stdout ?? "");
}

/** Supabase containers already running on this machine: any CLI stack (supabase_* names) and any
 * other lane's container built from a Supabase image (e.g. a bare supabase/postgres database). */
export function runningSupabaseContainers(spawn = spawnSync) {
  const result = spawn("docker", ["ps", "--format", "{{.Names}}\t{{.Image}}"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`docker is not reachable: ${String(result.stderr ?? result.error ?? "").trim().slice(0, 200)}`);
  }
  return String(result.stdout).split("\n").map(line => line.trim()).filter(Boolean)
    .filter(line => { const [name = "", image = ""] = line.split("\t"); return /^supabase_/.test(name) || /(^|\/)supabase\//.test(image); })
    .map(line => line.split("\t")[0]);
}

/** QA containers or volumes still present after teardown (should be empty). */
export function leftovers(spawn = spawnSync) {
  const run = argv => {
    const result = spawn("docker", argv, { encoding: "utf8" });
    if (result.error || result.status !== 0) throw new Error(`docker ${argv[0]} failed`);
    return String(result.stdout).split("\n").map(s => s.trim()).filter(Boolean);
  };
  const mine = name => name.endsWith(`_${QA_PROJECT_ID}`) || name.includes(`_${QA_PROJECT_ID}_`);
  return {
    containers: run(["ps", "-a", "--format", "{{.Names}}"]).filter(mine),
    volumes: run(["volume", "ls", "--format", "{{.Name}}"]).filter(mine),
  };
}

export function freeBytes(path) {
  const stats = statfsSync(path);
  return stats.bavail * stats.bsize;
}

/** Parse and validate `supabase status -o json`. Every URL must be local. */
export function parseStatus(json) {
  let raw;
  try { raw = JSON.parse(json); } catch { throw new Error("supabase status did not return JSON"); }
  const pick = (...names) => names.map(name => raw[name]).find(value => typeof value === "string" && value !== "");
  const status = {
    apiUrl: pick("API_URL"),
    dbUrl: pick("DB_URL"),
    mailpitUrl: pick("MAILPIT_URL", "INBUCKET_URL"),
    anonKey: pick("ANON_KEY", "PUBLISHABLE_KEY"),
    serviceRoleKey: pick("SERVICE_ROLE_KEY", "SECRET_KEY"),
  };
  for (const [label, value] of Object.entries(status)) {
    if (!value) throw new Error(`supabase status is missing ${label}`);
  }
  assertLocalUrl(status.apiUrl, "API_URL");
  assertLocalUrl(status.dbUrl, "DB_URL");
  assertLocalUrl(status.mailpitUrl, "MAILPIT_URL");
  return Object.freeze(status);
}

/** Start the QA stack. Refuses on a linked checkout, a non-local environment, another running
 * Supabase stack, or less than 10 GB free. Returns the validated status. */
export function start({ root = REPO, mirror = DEFAULT_MIRROR, env = process.env, spawn = spawnSync, free = freeBytes } = {}) {
  assertLocalOnly({ root, env });
  const others = runningSupabaseContainers(spawn);
  if (others.length) throw new LocalOnlyRefusal(`another Supabase stack is running (${others.slice(0, 3).join(", ")}); not starting a second one`);
  const bytes = free(dirname(resolve(mirror)));
  if (bytes < MIN_FREE_BYTES) throw new LocalOnlyRefusal(`only ${(bytes / 1024 ** 3).toFixed(1)} GB free; the floor is 10 GB`);
  buildMirror({ root, mirror });
  runCli(["start", "--workdir", mirror, "--exclude", EXCLUDE], { mirror, env, spawn });
  return status({ root, mirror, env, spawn });
}

export function status({ root = REPO, mirror = DEFAULT_MIRROR, env = process.env, spawn = spawnSync } = {}) {
  assertLocalOnly({ root, env });
  if (!existsSync(join(mirror, "supabase/config.toml"))) throw new Error(`no QA mirror at ${mirror}; run start first`);
  return parseStatus(runCli(["status", "--workdir", mirror, "-o", "json"], { mirror, env, spawn }));
}

/** Stop with --no-backup, then prove nothing of the QA stack is left, then delete the mirror. */
export function stop({ root = REPO, mirror = DEFAULT_MIRROR, env = process.env, spawn = spawnSync } = {}) {
  assertLocalOnly({ root, env });
  if (existsSync(join(mirror, "supabase/config.toml"))) {
    runCli(["stop", "--workdir", mirror, "--no-backup"], { mirror, env, spawn });
  }
  const left = leftovers(spawn);
  if (left.containers.length || left.volumes.length) {
    throw new Error(`teardown incomplete: ${JSON.stringify(left)}`);
  }
  rmSync(mirror, { recursive: true, force: true });
  return left;
}
