// The QA local Supabase stack (L8): a disposable mirror of this checkout's supabase/ project, started
// under its own project id (the mirror's directory name, e.g. "still-qa-backend"), so its containers
// and volumes are unmistakably that mirror's QA stack's,
// with a QA-only sign-in email template that shows the one-time code. The repository's own
// supabase/config.toml is never edited.
//
// The mirror holds:
//   supabase/config.toml        copied; project_id rewritten to the mirror name; sign-in templates
//                               replaced by the QA code template; any SMTP block removed, so the QA
//                               stack can only deliver to its local Mailpit
//   supabase/migrations/**      copied
//   supabase/functions/**       copied (Edge Functions are served from the mirror)
//   supabase/templates/qa-code.html
//   packages/core/src/**, packages/shared-types/{src,fixtures}/**
//                               copied, because functions import them by relative path
//   .qa-owner                   a random token; only the caller holding it may stop this stack
//
// Only git-tracked files are copied (git ls-files), so untracked secrets such as functions/.env
// never reach the mirror. The mirror may only be /private/tmp/still-qa-backend or
// /private/tmp/still-qa-<name>, and every CLI call first re-reads the mirror's config and refuses
// unless it declares exactly one project_id, the mirror's own.
//
// Only three Supabase CLI commands ever run, each checked by guard.assertAllowedCli:
//   supabase start  --workdir <mirror> --exclude <services QA does not need>
//   supabase status --workdir <mirror> -o json
//   supabase stop   --workdir <mirror> --no-backup
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAllowedCli, assertAllowedDocker, writerLoginArgs, QA_WRITER_PASSWORD, WRITER_LOGIN_SQL, assertLocalEnv, assertLocalOnly, assertLocalUrl, assertNotLinked, LocalOnlyRefusal } from "./guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../../..");
/** Each mirror is its own Supabase project: project_id is the mirror's directory name. */
export function projectIdFor(mirror) {
  const id = basename(resolve(mirror));
  if (!/^still-qa-[a-z0-9-]{1,60}$/.test(id)) throw new LocalOnlyRefusal(`mirror name ${id} is not a QA project id`);
  return id;
}
export const DEFAULT_MIRROR = "/private/tmp/still-qa-backend";
/** Any other mirror must sit directly under /private/tmp with this prefix (tests use it). */
export const MIRROR_PREFIX = "/private/tmp/still-qa-";
/** Written by buildMirror; stop() refuses unless the caller holds the same token. */
export const OWNER_FILE = ".qa-owner";
/** The checkout paths the mirror copies, git-tracked files only. */
export const MIRRORED_PATHS = Object.freeze(["supabase/migrations", "supabase/functions", "packages/core/src", "packages/shared-types/src", "packages/shared-types/fixtures"]);
/** Services QA never needs. Auth (gotrue), the API gateway, PostgREST, Edge Functions, Mailpit and
 * Realtime (live cross-device push) stay. */
export const EXCLUDE = "studio,imgproxy,logflare,vector,storage-api,supavisor,postgres-meta";
/** The issuer the Edge Functions expect: `${SUPABASE_URL}/auth/v1` with the in-network gateway as
 * SUPABASE_URL. Without it every real session is answered 401 by sync-settings and delete-user. */
export const QA_JWT_ISSUER = "http://kong:8000/auth/v1";
/** The narrow settings-writer role's disposable local password (the QA database holds no real data
 * and is reachable only on this machine); mirrors scripts/backend/rehearse-settings.sh. */
export { QA_WRITER_PASSWORD, WRITER_LOGIN_SQL };
export const QA_WRITER_DB_URL = `postgresql://still_settings_writer:${QA_WRITER_PASSWORD}@db:5432/postgres`;
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

/** Tables the QA copy drops: the sign-in templates it replaces with its own code template, and any
 * custom SMTP sender (the QA stack must only ever deliver to its local Mailpit). */
const DROPPED_TABLE = /^\[auth\.email\.(template\.(magic_link|confirmation)|smtp)\]\s*(#.*)?$/;

/** Rewrite a copied config for the mirror `projectId`: exactly one project_id line (rewritten),
 * sign-in template and SMTP tables removed, the QA code template appended. Refuses forms it cannot
 * rewrite safely (dotted or inline smtp/template keys, smtp sub-tables). */
export function qaConfig(source, projectId) {
  if (!/^still-qa-[a-z0-9-]{1,60}$/.test(String(projectId))) throw new LocalOnlyRefusal("qaConfig needs a still-qa-* project id");
  const lines = source.split("\n");
  const ids = lines.filter(line => /^project_id\s*=/.test(line));
  if (ids.length !== 1) throw new LocalOnlyRefusal("config.toml must have exactly one project_id line");
  const kept = [];
  let dropping = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) dropping = DROPPED_TABLE.test(line.trim());
    if (!dropping) kept.push(/^project_id\s*=/.test(line) ? `project_id = "${projectId}"` : line);
  }
  const live = kept.filter(line => !/^\s*(#|$)/.test(line));
  if (live.some(line => /^\s*\[[^\]]*\bsmtp\b/.test(line) || /^\s*smtp(\.|\s*=)/.test(line) || /^\s*template\.(magic_link|confirmation)\b/.test(line) || /^\s*\[auth\.email\.template\.(magic_link|confirmation)\./.test(line))) {
    throw new LocalOnlyRefusal("config.toml sets SMTP or a sign-in template in a form the QA copy cannot remove");
  }
  return withSyncServing(kept).join("\n") + QA_TEMPLATE_TOML;
}

/** Put `entry` directly under the live `[table]` header (appending the table when absent), after
 * dropping any live line of the same key so the key is never duplicated. */
function setInTable(lines, table, key, entry) {
  const header = lines.findIndex(line => line.trim() === `[${table}]`);
  const keyed = new RegExp(`^\\s*${key}\\s*=`);
  if (header === -1) return [...lines, "", `[${table}]`, entry];
  const out = [];
  let inTable = false;
  lines.forEach((line, i) => {
    if (/^\s*\[/.test(line)) inTable = i === header;
    if (inTable && keyed.test(line)) return;
    out.push(line);
    if (i === header) out.push(entry);
  });
  return out;
}

/** What the signed-in QA journeys need (sync-settings, delete-user): the issuer the functions
 * check and the settings-writer connection string. Both are local-only values. */
function withSyncServing(lines) {
  const issued = setInTable(lines, "auth", "jwt_issuer", `jwt_issuer = "${QA_JWT_ISSUER}"`);
  return setInTable(issued, "edge_runtime.secrets", "SETTINGS_WRITER_DB_URL", `SETTINGS_WRITER_DB_URL = "${QA_WRITER_DB_URL}"`);
}

/** The only places a mirror may be created or deleted: DEFAULT_MIRROR, or a directory directly
 * under /private/tmp named still-qa-*, and never the checkout, inside it or above it. */
export function assertMirrorPath(mirror, root = REPO) {
  const m = resolve(mirror);
  const r = resolve(root);
  const allowed = m === DEFAULT_MIRROR || (m.startsWith(MIRROR_PREFIX) && !m.slice(MIRROR_PREFIX.length).includes("/") && m.length > MIRROR_PREFIX.length);
  if (!allowed) throw new LocalOnlyRefusal(`mirror ${m} is not ${DEFAULT_MIRROR} or ${MIRROR_PREFIX}<name>`);
  if (m === r || r.startsWith(m + "/") || m.startsWith(r + "/")) throw new LocalOnlyRefusal("the mirror must not be the checkout, inside it or above it");
  return m;
}

/** Refuse unless the mirror's config declares exactly one project_id, and it is the QA one. */
export function assertQaMirrorConfig(mirror) {
  const file = join(mirror, "supabase/config.toml");
  if (!existsSync(file)) throw new LocalOnlyRefusal(`no QA mirror config at ${file}`);
  const ids = readFileSync(file, "utf8").split("\n").filter(line => /^\s*project_id\s*=/.test(line));
  const id = projectIdFor(mirror);
  if (ids.length !== 1 || ids[0].trim() !== `project_id = "${id}"`) {
    throw new LocalOnlyRefusal(`the mirror config at ${file} is not this mirror's QA project (${id})`);
  }
}

/** Git-tracked files under the mirrored paths (relative to root). Refuses outside a git checkout. */
export function trackedFiles(root, spawn = spawnSync, env = process.env) {
  // GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and friends could point git at another repository.
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !/^GIT_/i.test(name)));
  const result = spawn("git", ["-C", root, "ls-files", "-z", "--", ...MIRRORED_PATHS], { encoding: "utf8", env: clean });
  if (result.error || result.status !== 0) throw new LocalOnlyRefusal("the checkout is not a git repository; the mirror copies tracked files only");
  return String(result.stdout).split("\0").filter(Boolean);
}

/** Atomically claim an absent mirror: a non-recursive mkdir (fails if any other run created it) and
 * the owner token written with flag "wx" (fails if a token already exists). Returns the token. */
export function claimMirror(mirror) {
  try {
    mkdirSync(mirror);
  } catch (error) {
    if (error?.code === "EEXIST") throw new LocalOnlyRefusal(`another QA run claimed ${mirror} first`);
    throw error;
  }
  return writeOwnerToken(mirror);
}

/** Write a fresh owner token with flag "wx": refuses, keeping the existing one, if any token exists. */
export function writeOwnerToken(mirror) {
  const token = randomUUID();
  try {
    writeFileSync(join(mirror, OWNER_FILE), token, { flag: "wx" });
  } catch {
    throw new LocalOnlyRefusal(`another QA run claimed ${mirror} first`);
  }
  return token;
}

/** Build the mirror from `root` and claim it. The mirror is the lock: an owned mirror (one with a
 * .qa-owner token) is never wiped, the directory is created with a non-recursive mkdir and the token
 * with flag "wx", so of two concurrent starts only one can win. A stale mirror without a token (a
 * run that died before claiming it) is moved aside atomically before removal. Returns the owner
 * token stop() will require. */
export function buildMirror({ root = REPO, mirror = DEFAULT_MIRROR, git = spawnSync, env = process.env } = {}) {
  assertNotLinked(root);
  mirror = assertMirrorPath(mirror, root);
  const projectId = projectIdFor(mirror);
  const files = trackedFiles(root, git, env);
  // Rewrite the config before claiming anything, so a config the QA copy cannot use fails early.
  const config = qaConfig(readFileSync(join(root, "supabase/config.toml"), "utf8"), projectId);
  // A sibling lock directory serialises inspect -> replace -> claim between concurrent starts.
  const lock = `${mirror}.lock`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error?.code === "EEXIST") throw new LocalOnlyRefusal(`another QA run is building ${mirror} (${lock} exists; if no run is active, remove that empty directory)`);
    throw error;
  }
  let token;
  try {
    if (existsSync(join(mirror, OWNER_FILE))) {
      throw new LocalOnlyRefusal(`${mirror} is owned by another QA run (${OWNER_FILE} exists): stop it with its token, or see "lost token" in qa-backend.mjs`);
    }
    if (existsSync(mirror)) {
      const stale = `${mirror}.stale-${process.pid}-${Date.now()}`;
      renameSync(mirror, stale);
      rmSync(stale, { recursive: true, force: true });
    }
    token = claimMirror(mirror);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
  try {
    for (const file of files) {
      mkdirSync(dirname(join(mirror, file)), { recursive: true });
      cpSync(join(root, file), join(mirror, file));
    }
    mkdirSync(join(mirror, "supabase/templates"), { recursive: true });
    cpSync(TEMPLATE, join(mirror, "supabase/templates/qa-code.html"));
    writeFileSync(join(mirror, "supabase/config.toml"), config);
    assertNotLinked(mirror);
    assertQaMirrorConfig(mirror);
  } catch (error) {
    // No stack can exist yet: release the claim so the mirror is never left wedged.
    rmSync(mirror, { recursive: true, force: true });
    throw error;
  }
  return token;
}

/** The environment handed to the Supabase CLI: every SUPABASE_* variable removed (defence in depth;
 * runCli already refuses such an environment). */
export function cliEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^SUPABASE_/i.test(name)));
}

/** Run one allowed Supabase CLI command with a scrubbed environment. */
export function runCli(args, { mirror = DEFAULT_MIRROR, env = process.env, spawn = spawnSync } = {}) {
  assertMirrorPath(mirror);
  assertLocalEnv(env);
  assertAllowedCli(args, mirror, EXCLUDE);
  assertNotLinked(mirror);
  assertQaMirrorConfig(mirror);
  const result = spawn("supabase", args, { cwd: mirror, env: cliEnv(env), encoding: "utf8" });
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
export function leftovers(spawn = spawnSync, projectId) {
  if (!projectId) throw new Error("leftovers needs the mirror's project id");
  const run = argv => {
    const result = spawn("docker", argv, { encoding: "utf8" });
    if (result.error || result.status !== 0) throw new Error(`docker ${argv[0]} failed`);
    return String(result.stdout).split("\n").map(s => s.trim()).filter(Boolean);
  };
  const mine = name => name.endsWith(`_${projectId}`) || name.includes(`_${projectId}_`);
  return {
    containers: run(["ps", "-a", "--format", "{{.Names}}"]).filter(mine),
    volumes: run(["volume", "ls", "--format", "{{.Name}}"]).filter(mine),
  };
}

/** Run WRITER_LOGIN_SQL (the NOLOGIN `still_settings_writer` role gets its disposable local password) inside this mirror's own database container, and nowhere else. */
export function enableSettingsWriter({ mirror = DEFAULT_MIRROR, env = process.env, spawn = spawnSync } = {}) {
  mirror = assertMirrorPath(mirror);
  assertLocalEnv(env);
  assertQaMirrorConfig(mirror);
  const args = writerLoginArgs(mirror);
  assertAllowedDocker(args, mirror);
  const result = spawn("docker", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`enabling the settings writer failed (${result.status}): ${String(result.stderr ?? "").trim().slice(-400)}`);
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
 * Supabase stack, or less than 10 GB free. Returns the validated status plus the owner token that
 * stop() requires, so only the invocation that started the stack can tear it down. */
export function start({ root = REPO, mirror = DEFAULT_MIRROR, env = process.env, spawn = spawnSync, free = freeBytes } = {}) {
  assertLocalOnly({ root, env });
  const others = runningSupabaseContainers(spawn);
  if (others.length) throw new LocalOnlyRefusal(`another Supabase stack is running (${others.slice(0, 3).join(", ")}); not starting a second one`);
  const bytes = free(dirname(resolve(mirror)));
  if (bytes < MIN_FREE_BYTES) throw new LocalOnlyRefusal(`only ${(bytes / 1024 ** 3).toFixed(1)} GB free; the floor is 10 GB`);
  const token = buildMirror({ root, mirror, env });
  try {
    runCli(["start", "--workdir", mirror, "--exclude", EXCLUDE], { mirror, env, spawn });
    enableSettingsWriter({ mirror, env, spawn });
    return { ...status({ root, mirror, env, spawn }), token };
  } catch (error) {
    // The docker check above proved no other stack was running, so anything running now is ours:
    // tear it down with the token just created. If that fails too, surface the token so the caller
    // (smoke, the CLI or a person) can stop it; it is also in <mirror>/.qa-owner.
    try {
      stop({ root, mirror, env, spawn, token });
    } catch (teardown) {
      const wrapped = new Error(`${error?.message ?? error}; teardown also failed (${teardown?.message ?? teardown}); owner token ${token}`);
      wrapped.qaToken = token;
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}

export function status({ root = REPO, mirror = DEFAULT_MIRROR, env = process.env, spawn = spawnSync } = {}) {
  assertLocalOnly({ root, env });
  assertQaMirrorConfig(mirror);
  return parseStatus(runCli(["status", "--workdir", mirror, "-o", "json"], { mirror, env, spawn }));
}

/** Stop with --no-backup, then prove nothing of the QA stack is left, then delete the mirror.
 * The guarantee is project_id scoping: this mirror's config names its own project (its directory
 * name), so `supabase stop --no-backup` and the leftover check only ever touch that project's
 * containers and volumes, never another mirror's or another lane's stack.
 * Only the holder of the mirror's owner token (returned by start) may stop it. */
export function stop({ root = REPO, mirror = DEFAULT_MIRROR, env = process.env, spawn = spawnSync, token } = {}) {
  assertLocalOnly({ root, env });
  mirror = assertMirrorPath(mirror, root);
  const ownerFile = join(mirror, OWNER_FILE);
  const owner = existsSync(ownerFile) ? readFileSync(ownerFile, "utf8").trim() : null;
  if (typeof token !== "string" || !token || owner !== token) {
    throw new LocalOnlyRefusal("this caller did not start the QA stack in that mirror (owner token mismatch); not stopping it");
  }
  runCli(["stop", "--workdir", mirror, "--no-backup"], { mirror, env, spawn });
  const left = leftovers(spawn, projectIdFor(mirror));
  if (left.containers.length || left.volumes.length) {
    throw new Error(`teardown incomplete: ${JSON.stringify(left)}`);
  }
  rmSync(mirror, { recursive: true, force: true });
  return left;
}
