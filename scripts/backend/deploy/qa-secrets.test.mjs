import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  lintVerificationSql,
  OWNER_REVIEWER_ID,
  sha256,
  stripComments,
} from "./deploy.mjs";
import { terminateStatement } from "./operations.mjs";
import { REQUIRED_SECRETS } from "./qa-functions.mjs";
import {
  assertWritableName,
  createQaSecretsPlan,
  DISABLE_SECRETS,
  generatePassword,
  parseRoleState,
  QA_ROLE_LOGINS,
  QA_SECRETS_SQL,
  renderQaSecretsFinal,
  renderQaSecretsPlan,
  roleDbUrl,
  ROLE_FACTS,
  runQaSecretsOperation,
  SCRAM_VERIFIER,
  scramKeys,
  scramSha256Verifier,
  STAGED_SECRETS,
} from "./qa-secrets.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const REF = "abcdefghijklmnopqrst";
const ROLES = QA_ROLE_LOGINS.map((item) => item.role);
const WRITER = "still_qa_sandbox_writer";
// Built at runtime so no credential-shaped literal sits in the source (push protection).
const fakeToken = () => ["sbp", "0f".repeat(20)].join("_");
const fakeStripeKey = () =>
  ["sk", "test", `SENTINELSTRIPE${"q".repeat(16)}`].join("_");
const ADMIN_PASSWORD = "SENTINELADMINPASSWORDzzzz";
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

// ── SCRAM-SHA-256 ──────────────────────────────────────────────────────────────────────────────

test("SCRAM keys reproduce the RFC 7677 exchange (ClientProof and ServerSignature)", () => {
  const salt = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
  const { clientKey, storedKey, serverKey } = scramKeys("pencil", salt, 4096);
  const clientFirstBare = "n=user,r=rOprNGfwEbeRWgbNEkqO";
  const serverFirst =
    "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
  const clientFinalNoProof =
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
  const auth = `${clientFirstBare},${serverFirst},${clientFinalNoProof}`;
  const clientSignature = createHmac("sha256", storedKey).update(auth).digest();
  const proof = Buffer.from(
    clientKey.map((byte, i) => byte ^ clientSignature[i]),
  );
  assert.equal(b64(proof), "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=");
  const serverSignature = createHmac("sha256", serverKey).update(auth).digest();
  assert.equal(
    b64(serverSignature),
    "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
  );
  assert.deepEqual(storedKey, createHash("sha256").update(clientKey).digest());
});

test("SCRAM verifier uses PostgreSQL's stored format and refuses unsafe inputs", () => {
  const salt = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
  const verifier = scramSha256Verifier("pencil", { salt });
  const { storedKey, serverKey } = scramKeys("pencil", salt);
  assert.equal(
    verifier,
    `SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$${b64(storedKey)}:${b64(serverKey)}`,
  );
  assert.match(verifier, SCRAM_VERIFIER);
  assert.match(scramSha256Verifier("a".repeat(64)), SCRAM_VERIFIER);
  for (const [password, options] of [
    ["", {}],
    ["päss", {}],
    ["has space", {}],
    ["ok", { salt: Buffer.alloc(8) }],
    ["ok", { iterations: 1000 }],
  ]) {
    assert.throws(() => scramSha256Verifier(password, options), {
      category: "qa-password-invalid",
    });
  }
  assert.doesNotMatch("pencil", SCRAM_VERIFIER);
  assert.doesNotMatch("md5" + "a".repeat(32), SCRAM_VERIFIER);
});

test("passwords are 32 random bytes as hex; URLs use the direct host and the exact role", () => {
  const password = generatePassword();
  assert.match(password, /^[a-f0-9]{64}$/);
  assert.notEqual(password, generatePassword());
  for (const role of ROLES) {
    assert.equal(
      roleDbUrl(REF, role, password),
      `postgresql://${role}:${password}@db.${REF}.supabase.co:5432/postgres?sslmode=require`,
    );
  }
  for (const args of [
    ["ABC", ROLES[0], password],
    [REF, "postgres", password],
    [REF, `${WRITER}.${REF}`, password],
    [REF, ROLES[0], "short"],
    [REF, ROLES[0], `${"a".repeat(63)}@`],
  ]) {
    assert.throws(() => roleDbUrl(...args), {
      category: "qa-secrets-url-invalid",
    });
  }
  assert.throws(() => generatePassword(() => Buffer.alloc(8)), {
    category: "qa-password-invalid",
  });
});

// ── Allowlist and pinned SQL ───────────────────────────────────────────────────────────────────

test("the writable names are exactly REQUIRED_SECRETS; staged names map QA_STAGE_<SUFFIX>", () => {
  const generated = QA_ROLE_LOGINS.map((item) => item.secret);
  assert.deepEqual(
    [...generated, ...STAGED_SECRETS.map((item) => item.name)].sort(),
    [...REQUIRED_SECRETS].sort(),
  );
  assert.equal(STAGED_SECRETS.length, 19);
  for (const { name, from } of STAGED_SECRETS) {
    assert.equal(name, `STILL_QA_SANDBOX_${from.slice("QA_STAGE_".length)}`);
  }
  assert.deepEqual(
    DISABLE_SECRETS,
    REQUIRED_SECRETS.filter((name) => name.startsWith("STILL_QA_SANDBOX_")),
  );
  assert.ok(!DISABLE_SECRETS.includes("SETTINGS_WRITER_DB_URL"));
  assert.ok(!DISABLE_SECRETS.includes("PRODUCT_POLICY_READER_DB_URL"));
  for (const name of [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "supabase_x",
    "OTHER",
    7,
  ]) {
    assert.throws(() => assertWritableName(name), {
      category: "qa-secrets-name-refused",
    });
  }
  assert.throws(
    () => assertWritableName("SETTINGS_WRITER_DB_URL", { remove: true }),
    { category: "qa-secrets-name-refused" },
  );
  assertWritableName("SETTINGS_WRITER_DB_URL");
  assertWritableName("STILL_QA_SANDBOX_STRIPE_PRICE_ID", { remove: true });
});

test("pinned SQL matches its hashes and has only the promised statement shapes", async () => {
  for (const pin of Object.values(QA_SECRETS_SQL)) {
    assert.equal(
      sha256(await readFile(join(ROOT, pin.path))),
      pin.sha256,
      pin.path,
    );
  }
  const verify = await readFile(join(ROOT, QA_SECRETS_SQL.verify.path), "utf8");
  assert.equal(lintVerificationSql(verify), true);
  const login = await readFile(join(ROOT, QA_SECRETS_SQL.login.path), "utf8");
  const statements = stripComments(login)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual(
    statements.filter((line) => line.startsWith("alter")),
    [
      "alter role still_policy_reader with login password :'qa_policy_reader_verifier';",
      "alter role still_settings_writer with login password :'qa_settings_writer_verifier';",
      "alter role still_qa_sandbox_writer with login password :'qa_writer_verifier';",
    ],
  );
  assert.ok(
    statements.every(
      (line) =>
        line.startsWith("alter role ") || /^\\(getenv|if|endif)\b/.test(line),
    ),
  );
  for (const { variable } of QA_ROLE_LOGINS) {
    assert.ok(login.includes(` ${variable}\n`), variable);
  }
  const disable = stripComments(
    await readFile(join(ROOT, QA_SECRETS_SQL.disable.path), "utf8"),
  )
    .split(";")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  assert.deepEqual(disable, [
    "alter role still_qa_sandbox_writer nologin",
    terminateStatement(WRITER),
  ]);
});

test("role state parsing accepts only the three roles and complete facts", () => {
  const state = parseRoleState([
    "still_policy_reader:login",
    "still_policy_reader:password-unreadable",
    "still_qa_sandbox_writer:missing",
    "still_settings_writer:nologin",
    "still_settings_writer:password-none",
  ]);
  assert.deepEqual(state.get("still_policy_reader"), {
    exists: true,
    login: true,
    password: "unreadable",
  });
  assert.equal(state.get(WRITER).exists, false);
  for (const bad of [
    ["postgres:login"],
    ["still_policy_reader:login"],
    [...facts(), "still_policy_reader:login"],
    [...facts(), "still_qa_sandbox_writer:missing"],
    [...facts().slice(1), "still_policy_reader:superuser"],
    "[]",
  ])
    assert.throws(() => parseRoleState(bad), {
      category: "qa-role-state-invalid",
    });
  function facts() {
    return ROLES.flatMap((role) => [
      `${role}:nologin`,
      `${role}:password-none`,
    ]);
  }
});

test("plans bind the pinned SQL, list names only and refuse altered bytes", async (t) => {
  const plan = await createQaSecretsPlan({
    mode: "apply",
    projectRef: REF,
    sourceDir: ROOT,
  });
  assert.equal(plan.files.length, 4);
  assert.ok(plan.files.some((file) => file.path === ROLE_FACTS));
  assert.equal(
    plan.digest,
    (
      await createQaSecretsPlan({
        mode: "apply",
        projectRef: REF,
        sourceDir: ROOT,
      })
    ).digest,
  );
  assert.notEqual(
    plan.digest,
    (
      await createQaSecretsPlan({
        mode: "rotate",
        projectRef: REF,
        sourceDir: ROOT,
      })
    ).digest,
  );
  assert.match(renderQaSecretsPlan(plan), /QA sandbox secrets apply plan/);
  for (const input of [
    { mode: "delete", projectRef: REF },
    { mode: "apply", projectRef: "short" },
    { mode: "apply", projectRef: REF, revision: "abc" },
  ]) {
    await assert.rejects(createQaSecretsPlan({ ...input, sourceDir: ROOT }), {
      category: "qa-secrets-input-invalid",
    });
  }
  const copy = await mkdtemp(join(tmpdir(), "still-qa-secrets-plan-"));
  t.after(() => rm(copy, { recursive: true, force: true }));
  for (const path of [
    ...Object.values(QA_SECRETS_SQL).map((p) => p.path),
    ROLE_FACTS,
  ]) {
    await mkdir(dirname(join(copy, path)), { recursive: true });
    await cp(join(ROOT, path), join(copy, path));
  }
  await writeFile(
    join(copy, QA_SECRETS_SQL.login.path),
    "alter role postgres with superuser;\n",
  );
  await assert.rejects(
    createQaSecretsPlan({ mode: "apply", projectRef: REF, sourceDir: copy }),
    { category: "qa-secrets-sql-unpinned" },
  );
});

// ── Run harness: fake GitHub, fake Management API, fake psql ────────────────────────────────────

function stagedValues() {
  const values = {};
  // High-entropy synthetic values that share no text with any name, so partial leaks show.
  for (const { from } of STAGED_SECRETS) {
    values[from] = `SENTINEL${sha256(from).slice(0, 32)}`;
  }
  values.QA_STAGE_STRIPE_SECRET_API_KEY = fakeStripeKey();
  values.QA_STAGE_APP_STORE_SERVER_PRIVATE_KEY =
    "-----BEGIN PRIVATE KEY-----\nSENTINELPEMBODY\n-----END PRIVATE KEY-----";
  return values;
}

/** Decodes a stored verifier and checks a password against it, as the server would. */
function verifierAccepts(verifier, password) {
  const match = SCRAM_VERIFIER.exec(verifier ?? "");
  if (!match) return false;
  const { storedKey } = scramKeys(
    password,
    Buffer.from(match[2], "base64"),
    Number(match[1]),
  );
  return b64(storedKey) === match[3];
}

async function harness(
  t,
  {
    mode = "apply",
    roles: initialRoles = {},
    secrets: initialSecrets = {},
    env: envOverrides = {},
    controls: initialControls = {},
  } = {},
) {
  const plan = await createQaSecretsPlan({
    mode,
    projectRef: REF,
    sourceDir: ROOT,
  });
  const roles = new Map(
    ROLES.map((role) => [
      role,
      { login: false, verifier: null, ...initialRoles[role] },
    ]),
  );
  // name -> value (the fake keeps values to compute digests; the module never sees them back).
  const store = new Map(Object.entries(initialSecrets));
  const controls = {
    approval: true,
    psqlMajor: 16,
    postFailure: null,
    deleteFailure: null,
    getStatuses: [],
    corruptDigest: null,
    loginFails: false,
    probeFails: false,
    extraFactChange: false,
    unreadable: false,
    ...initialControls,
  };
  const calls = {
    fetch: [],
    exec: [],
    posts: [],
    deletes: [],
    verifiers: [],
    probes: [],
  };
  const fetchImpl = async (url, options = {}) => {
    calls.fetch.push({
      url,
      method: options.method,
      redirect: options.redirect,
      signal: !!options.signal,
    });
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.startsWith("https://api.github.com/")) {
      if (url.endsWith("/environments/supabase-production")) {
        return json({
          name: "supabase-production",
          id: 7,
          can_admins_bypass: false,
          protection_rules: [
            {
              type: "required_reviewers",
              reviewers: [
                { type: "User", reviewer: { id: OWNER_REVIEWER_ID } },
              ],
            },
          ],
          deployment_branch_policy: {
            custom_branch_policies: true,
            protected_branches: false,
          },
        });
      }
      if (url.includes("/deployment-branch-policies")) {
        return json({
          total_count: 1,
          branch_policies: [{ name: "main", type: "branch" }],
        });
      }
      if (url.includes("/approvals")) {
        return json(
          controls.approval
            ? [
                {
                  state: "approved",
                  user: { id: OWNER_REVIEWER_ID },
                  environments: [{ id: 7 }],
                },
              ]
            : [],
        );
      }
      return json({}, 404);
    }
    assert.equal(url, `https://api.supabase.com/v1/projects/${REF}/secrets`);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    assert.equal(options.headers.Authorization, `Bearer ${fakeToken()}`);
    if (options.method === "GET") {
      const status = controls.getStatuses.shift();
      if (status === "throw") throw new TypeError("network");
      if (status) return json({ message: "unavailable" }, status);
      return json(
        [...store].map(([name, value]) => ({
          name,
          value:
            name === controls.corruptDigest ? "e".repeat(64) : sha256(value),
          updated_at: "2026-10-09T00:00:00Z",
        })),
      );
    }
    const body = JSON.parse(options.body);
    if (options.method === "POST") {
      calls.posts.push(body.map((item) => item.name));
      if (controls.postFailure === "throw") throw new TypeError("network");
      if (controls.postFailure === "partial") {
        store.set(body[0].name, body[0].value);
        return json({ message: "boom" }, 500);
      }
      if (controls.postFailure)
        return json({ message: "boom" }, controls.postFailure);
      for (const { name, value } of body) store.set(name, value);
      return new Response(null, { status: 201 });
    }
    if (options.method === "DELETE") {
      calls.deletes.push(body);
      if (controls.deleteFailure)
        return json({ message: "boom" }, controls.deleteFailure);
      for (const name of body) store.delete(name);
      return json({});
    }
    throw new Error(`unexpected ${options.method}`);
  };
  const roleFacts = () =>
    [
      ...ROLES.map((role) => `role ${role} | login ${roles.get(role).login}`),
      ...ROLES.map((role) => `role ${role} | inherit false`),
      "role postgres | login true",
      ...(controls.extraFactChange && roles.get(WRITER).login
        ? [
            "member still_qa_sandbox_writer of postgres | admin false inherit false set false",
          ]
        : []),
    ].sort();
  const stateFacts = () =>
    ROLES.flatMap((role) => {
      const item = roles.get(role);
      if (item.missing) return [`${role}:missing`];
      const password = controls.unreadable
        ? "unreadable"
        : item.verifier === null
          ? "none"
          : SCRAM_VERIFIER.test(item.verifier)
            ? "scram"
            : "other";
      return [
        `${role}:${item.login ? "login" : "nologin"}`,
        `${role}:password-${password}`,
      ];
    }).sort();
  const exec = async (cmd, args, { env = {} } = {}) => {
    calls.exec.push({ cmd, args: [...args], env: { ...env } });
    assert.equal(cmd, "psql");
    if (args[0] === "--version") {
      return {
        code: 0,
        stdout: `psql (PostgreSQL) ${controls.psqlMajor}.4 (Ubuntu)\n`,
        stderr: "",
      };
    }
    const file = args[args.indexOf("-f") + 1];
    if (args.includes("-f") && file.endsWith(QA_SECRETS_SQL.verify.path)) {
      assert.ok(
        args.includes("set session characteristics as transaction read only"),
      );
      return {
        code: 0,
        stdout: `${JSON.stringify(stateFacts())}\n`,
        stderr: "",
      };
    }
    if (args.includes("-f") && file.endsWith(ROLE_FACTS)) {
      return {
        code: 0,
        stdout: `${JSON.stringify(roleFacts())}\n`,
        stderr: "",
      };
    }
    if (args.includes("-f") && file.endsWith(QA_SECRETS_SQL.login.path)) {
      assert.ok(args.includes("--single-transaction"));
      assert.equal(env.PGUSER, `postgres.${REF}`);
      if (controls.loginFails)
        return { code: 3, stdout: "", stderr: "ERROR:  42501\n" };
      for (const { role, variable } of QA_ROLE_LOGINS) {
        if (env[variable] === undefined) continue;
        assert.match(env[variable], SCRAM_VERIFIER);
        calls.verifiers.push(env[variable]);
        Object.assign(roles.get(role), {
          login: true,
          verifier: controls.dropPassword ? null : env[variable],
        });
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args.includes("-f") && file.endsWith(QA_SECRETS_SQL.disable.path)) {
      assert.ok(!args.includes("--single-transaction"));
      roles.get(WRITER).login = false;
      return {
        code: 0,
        stdout: '{"closed" : 1, "remaining" : 0}\n',
        stderr: "",
      };
    }
    if (args.includes("select current_user")) {
      const role = env.PGUSER.replace(`.${REF}`, "");
      calls.probes.push({ user: env.PGUSER, host: env.PGHOST });
      const item = roles.get(role);
      const ok =
        !controls.probeFails &&
        item?.login &&
        verifierAccepts(item.verifier, env.PGPASSWORD);
      return ok
        ? { code: 0, stdout: `${role}\n`, stderr: "" }
        : {
            code: 2,
            stdout: "",
            stderr: `FATAL: password authentication failed for user "${env.PGUSER}"`,
          };
    }
    throw new Error(`unexpected psql ${args.join(" ")}`);
  };
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "ZackC-1/still-app",
    GH_TOKEN: "synthetic-github-token",
    GITHUB_RUN_ID: "123",
    EXPECTED_PLAN_DIGEST: plan.digest,
    DEPLOY_MODE: mode,
    SUPABASE_PRODUCTION_PROJECT_REF: REF,
    SUPABASE_DB_URL: `postgresql://postgres.${REF}:${ADMIN_PASSWORD}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`,
    SUPABASE_QA_SECRETS_ACCESS_TOKEN: fakeToken(),
    ...(mode === "disable" ? {} : stagedValues()),
    ...envOverrides,
  };
  for (const [key, value] of Object.entries(env))
    if (value === undefined) delete env[key];
  const snapshots = [];
  const generated = [];
  const randomBytesImpl = (size) => {
    const bytes = randomBytes(size);
    if (size === 32) generated.push(bytes.toString("hex"));
    return bytes;
  };
  const run = () =>
    runQaSecretsOperation({
      plan,
      env,
      platform: "linux",
      cwd: ROOT,
      sourceDir: ROOT,
      exec,
      fetchImpl,
      randomBytesImpl,
      sleep: async () => {},
      onProgress: async (receipt) => snapshots.push(receipt),
    });
  return {
    plan,
    env,
    roles,
    store,
    controls,
    calls,
    snapshots,
    generated,
    run,
  };
}

const outcomes = (list, key = "name") =>
  Object.fromEntries(list.map((item) => [item[key], item.outcome]));
const allLoggedIn = (extra = {}) =>
  Object.fromEntries(
    ROLES.map((role) => [
      role,
      {
        login: true,
        verifier:
          "SCRAM-SHA-256$4096:AAAAAAAAAAAAAAAAAAAAAA==$" +
          "A".repeat(43) +
          "=:" +
          "A".repeat(43) +
          "=",
        ...extra,
      },
    ]),
  );
function fullStore(overrides = {}) {
  const store = {};
  for (const { name, from } of STAGED_SECRETS)
    store[name] = stagedValues()[from];
  for (const { secret, role } of QA_ROLE_LOGINS) {
    store[secret] =
      `postgresql://${role}:${"9".repeat(64)}@db.${REF}.supabase.co:5432/postgres?sslmode=require`;
  }
  return { ...store, ...overrides };
}

// ── Apply ──────────────────────────────────────────────────────────────────────────────────────

test("apply installs every secret in one POST, then sets three SCRAM logins and verifies", async (t) => {
  const h = await harness(t);
  const receipt = await h.run();
  assert.equal(receipt.status, "verified", receipt.issues.join());
  assert.equal(receipt.writeAttempted, true);
  assert.equal(h.calls.posts.length, 1);
  assert.deepEqual([...h.calls.posts[0]].sort(), [...REQUIRED_SECRETS].sort());
  assert.deepEqual(receipt.counts.secrets, { installed: 22 });
  assert.deepEqual(receipt.counts.roles, { "login-set": 3 });
  for (const { role, secret } of QA_ROLE_LOGINS) {
    const url = new URL(h.store.get(secret));
    assert.equal(url.username, role);
    assert.equal(url.hostname, `db.${REF}.supabase.co`);
    assert.equal(url.port, "5432");
    assert.equal(url.searchParams.get("sslmode"), "require");
    assert.ok(verifierAccepts(h.roles.get(role).verifier, url.password), role);
    assert.ok(h.generated.includes(url.password));
  }
  for (const { name, from } of STAGED_SECRETS)
    assert.equal(h.store.get(name), h.env[from]);
  // The probe signs in through the admin URL's pooler host with the pooler user form.
  assert.deepEqual(
    h.calls.probes.map((item) => item.user).sort(),
    ROLES.map((role) => `${role}.${REF}`).sort(),
  );
  // The durable record says outcome-unknown before each write.
  const before = h.snapshots.find((item) => item.status === "writing-secrets");
  assert.ok(before.secrets.every((item) => item.outcome === "outcome-unknown"));
  const rolesBefore = h.snapshots.find(
    (item) => item.status === "writing-roles",
  );
  assert.ok(
    rolesBefore.roles.every((item) => item.outcome === "outcome-unknown"),
  );
  assert.ok(rolesBefore.secrets.every((item) => item.outcome === "installed"));
  assert.match(renderQaSecretsFinal(receipt), /status: verified/);
});

test("re-running apply after success writes nothing and reports unchanged", async (t) => {
  const h = await harness(t);
  assert.equal((await h.run()).status, "verified");
  const posts = h.calls.posts.length;
  const writes = h.calls.exec.filter((call) =>
    call.args.includes("--single-transaction"),
  ).length;
  const again = await h.run();
  assert.equal(again.status, "no-change");
  assert.equal(again.writeAttempted, false);
  assert.equal(h.calls.posts.length, posts);
  assert.equal(
    h.calls.exec.filter((call) => call.args.includes("--single-transaction"))
      .length,
    writes,
  );
  assert.deepEqual(again.counts.secrets, { unchanged: 22 });
  assert.deepEqual(again.counts.roles, { unchanged: 3 });
});

test("apply keeps a live login and its URL untouched and installs only the rest", async (t) => {
  const live =
    "postgresql://still_settings_writer:LIVEURLSENTINEL@db.x.supabase.co:5432/postgres";
  const h = await harness(t, {
    roles: { still_settings_writer: allLoggedIn().still_settings_writer },
    secrets: { SETTINGS_WRITER_DB_URL: live },
  });
  const receipt = await h.run();
  assert.equal(receipt.status, "verified", receipt.issues.join());
  assert.ok(!h.calls.posts[0].includes("SETTINGS_WRITER_DB_URL"));
  assert.equal(h.store.get("SETTINGS_WRITER_DB_URL"), live);
  const variables = h.calls.exec.find((call) =>
    call.args.includes("--single-transaction"),
  ).env;
  assert.equal(variables.STILL_QA_SETTINGS_WRITER_VERIFIER, undefined);
  assert.equal(
    outcomes(receipt.roles, "role").still_settings_writer,
    "unchanged",
  );
  assert.equal(outcomes(receipt.secrets).SETTINGS_WRITER_DB_URL, "unchanged");
  assert.deepEqual(receipt.counts.roles, { "login-set": 2, unchanged: 1 });
});

test("apply refuses to overwrite a different existing secret, before any write", async (t) => {
  const h = await harness(t, {
    secrets: {
      STILL_QA_SANDBOX_STRIPE_PRICE_ID: "price_old",
      STILL_QA_SANDBOX_STRIPE_ACCOUNT_ID: "acct_old",
    },
  });
  const receipt = await h.run();
  assert.equal(receipt.status, "stopped-before-write");
  assert.deepEqual(receipt.issues, [
    "qa-secret-exists",
    "qa-secret-exists:STILL_QA_SANDBOX_STRIPE_ACCOUNT_ID",
    "qa-secret-exists:STILL_QA_SANDBOX_STRIPE_PRICE_ID",
  ]);
  assert.equal(h.calls.posts.length, 0);
  assert.ok(
    receipt.secrets.every((item) => !item.outcome.startsWith("pending")),
  );
  assert.match(renderQaSecretsFinal(receipt), /Nothing was written/);
});

test("apply treats an equal existing secret as unchanged (not an overwrite)", async (t) => {
  const h = await harness(t, {
    secrets: {
      STILL_QA_SANDBOX_STRIPE_PRICE_ID: stagedValues().QA_STAGE_STRIPE_PRICE_ID,
    },
  });
  const receipt = await h.run();
  assert.equal(receipt.status, "verified", receipt.issues.join());
  assert.ok(!h.calls.posts[0].includes("STILL_QA_SANDBOX_STRIPE_PRICE_ID"));
  assert.equal(
    outcomes(receipt.secrets).STILL_QA_SANDBOX_STRIPE_PRICE_ID,
    "unchanged",
  );
});

test("apply refuses a URL without LOGIN or LOGIN without its URL (rotate decides)", async (t) => {
  for (const options of [
    {
      secrets: {
        STILL_QA_SANDBOX_ENTITLEMENT_WRITER_DB_URL:
          "postgresql://x:y@z/postgres",
      },
    },
    { roles: { [WRITER]: { login: true } } },
  ]) {
    const h = await harness(t, options);
    const receipt = await h.run();
    assert.equal(receipt.status, "stopped-before-write");
    assert.deepEqual(receipt.issues, [
      "qa-role-secret-mismatch",
      `qa-role-secret-mismatch:${WRITER}`,
    ]);
    assert.equal(h.calls.posts.length, 0);
  }
});

// ── Refusals before any write ───────────────────────────────────────────────────────────────────

test("readiness refusals stop before any write and before reading secrets", async (t) => {
  const cases = [
    [{ env: { QA_STAGE_STRIPE_PRICE_ID: "  " } }, "qa-stage-value-missing"],
    [
      { env: { QA_STAGE_STRIPE_PRICE_ID: undefined } },
      "qa-stage-value-missing",
    ],
    [{ env: { QA_STAGE_SUPABASE_URL: "x" } }, "qa-stage-unexpected"],
    [
      { env: { QA_STAGE_ENTITLEMENT_WRITER_DB_URL: "x" } },
      "qa-stage-unexpected",
    ],
    [
      { env: { SUPABASE_QA_SECRETS_ACCESS_TOKEN: "" } },
      "qa-secrets-token-missing",
    ],
    [
      { env: { SUPABASE_PRODUCTION_PROJECT_REF: "zyxwvutsrqponmlkjihg" } },
      "qa-secrets-target-invalid",
    ],
    [{ env: { DEPLOY_MODE: "rotate" } }, "qa-secrets-target-invalid"],
    [{ env: { EXPECTED_PLAN_DIGEST: "0".repeat(64) } }, "plan-differs"],
    [
      {
        env: {
          SUPABASE_DB_URL: `postgresql://postgres:${ADMIN_PASSWORD}@db.zyxwvutsrqponmlkjihg.supabase.co:5432/postgres`,
        },
      },
      "qa-target-invalid",
    ],
    [
      {
        env: {
          SUPABASE_DB_URL: `postgresql://postgres:${ADMIN_PASSWORD}@127.0.0.1:5432/postgres`,
        },
      },
      "qa-target-invalid",
    ],
    [
      {
        env: {
          SUPABASE_DB_URL: `postgresql://still_settings_writer:${ADMIN_PASSWORD}@db.${REF}.supabase.co:5432/postgres`,
        },
      },
      "qa-target-invalid",
    ],
    [{ env: { GITHUB_REF: "refs/heads/feature" } }, "context-invalid"],
    [{ controls: { approval: false } }, "qa-secrets-owner-approval-missing"],
    [{ controls: { psqlMajor: 14 } }, "qa-secrets-psql-too-old"],
    [{ roles: { [WRITER]: { missing: true } } }, "qa-role-missing"],
  ];
  for (const [options, category] of cases) {
    const h = await harness(t, options);
    const receipt = await h.run();
    assert.equal(receipt.status, "stopped-before-write", category);
    assert.equal(receipt.issues[0], category);
    assert.equal(receipt.writeAttempted, false);
    assert.equal(h.calls.posts.length + h.calls.deletes.length, 0, category);
    assert.ok(
      !h.calls.exec.some((call) => call.args.includes("--single-transaction")),
    );
  }
  const missing = await harness(t, {
    env: {
      QA_STAGE_STRIPE_PRICE_ID: "",
      QA_STAGE_WEB_RETURN_ORIGIN: undefined,
    },
  });
  assert.deepEqual((await missing.run()).issues, [
    "qa-stage-value-missing",
    "qa-stage-value-missing:QA_STAGE_STRIPE_PRICE_ID",
    "qa-stage-value-missing:QA_STAGE_WEB_RETURN_ORIGIN",
  ]);
});

test("a plan for plan-only or with a widened name list cannot run", async (t) => {
  const h = await harness(t);
  for (const plan of [
    await createQaSecretsPlan({
      mode: "plan-only",
      projectRef: REF,
      sourceDir: ROOT,
    }),
    { ...h.plan, removable: [...h.plan.removable, "SETTINGS_WRITER_DB_URL"] },
    {
      ...h.plan,
      staged: [
        ...h.plan.staged,
        { name: "SUPABASE_URL", from: "QA_STAGE_URL" },
      ],
    },
    {
      ...h.plan,
      files: h.plan.files.filter(
        (file) => file.path !== QA_SECRETS_SQL.login.path,
      ),
    },
  ]) {
    const receipt = await runQaSecretsOperation({
      plan,
      env: { ...h.env, EXPECTED_PLAN_DIGEST: plan.digest },
      platform: "linux",
      cwd: ROOT,
      sourceDir: ROOT,
      exec: async () => assert.fail("no exec"),
      fetchImpl: async () => assert.fail("no fetch"),
    });
    assert.equal(receipt.status, "stopped-before-write");
    assert.match(receipt.issues[0], /^qa-secrets-(plan-invalid|sql-unpinned)$/);
  }
});

// ── Reads retry; writes never do ────────────────────────────────────────────────────────────────

test("transient secret reads retry; a persistent read failure stops before writing", async (t) => {
  const h = await harness(t, { controls: { getStatuses: [503, "throw"] } });
  assert.equal((await h.run()).status, "verified");
  const failing = await harness(t, {
    controls: { getStatuses: [500, 502, 503] },
  });
  const receipt = await failing.run();
  assert.equal(receipt.status, "stopped-before-write");
  assert.deepEqual(receipt.issues, ["qa-secrets-read-failed"]);
  const denied = await harness(t, { controls: { getStatuses: [401] } });
  assert.deepEqual((await denied.run()).issues, ["qa-secrets-read-failed"]);
  assert.equal(
    denied.calls.fetch.filter((call) => call.url.includes("supabase.com"))
      .length,
    1,
  );
});

for (const failure of ["throw", 500, 400, "partial"]) {
  test(`a failed POST (${failure}) is never retried and records outcome-unknown`, async (t) => {
    const h = await harness(t, { controls: { postFailure: failure } });
    const receipt = await h.run();
    assert.equal(receipt.status, "outcome-unknown");
    assert.deepEqual(receipt.issues, ["qa-secrets-write-outcome-unknown"]);
    assert.equal(h.calls.posts.length, 1);
    assert.ok(
      receipt.secrets.every((item) => item.outcome === "outcome-unknown"),
    );
    assert.ok(receipt.roles.every((item) => item.outcome === "not-attempted"));
    assert.ok(
      !h.calls.exec.some((call) => call.args.includes("--single-transaction")),
    );
    assert.match(receipt.recovery, /do not re-run apply.*rotate/);
    assert.match(renderQaSecretsFinal(receipt), /outcome-unknown/);
  });
}

test("a digest mismatch after the POST stops before any role changes, naming the secret", async (t) => {
  const h = await harness(t, {
    controls: { corruptDigest: "STILL_QA_SANDBOX_WEB_RETURN_ORIGIN" },
  });
  const receipt = await h.run();
  assert.equal(receipt.status, "outcome-unknown");
  assert.deepEqual(receipt.issues, [
    "qa-secret-digest-mismatch",
    "qa-secret-digest-mismatch:STILL_QA_SANDBOX_WEB_RETURN_ORIGIN",
  ]);
  assert.ok(
    !h.calls.exec.some((call) => call.args.includes("--single-transaction")),
  );
  assert.ok(ROLES.every((role) => !h.roles.get(role).login));
});

test("an unrelated secret that moves during the run is a mismatch too", async (t) => {
  const h = await harness(t, { secrets: { OTHER_LIVE_SECRET: "live" } });
  const original = h.store.set.bind(h.store);
  h.store.set = (name, value) => {
    original(name, value);
    if (name === "SETTINGS_WRITER_DB_URL")
      original("OTHER_LIVE_SECRET", "changed");
    return h.store;
  };
  const receipt = await h.run();
  assert.equal(receipt.status, "outcome-unknown");
  assert.deepEqual(receipt.issues, [
    "qa-secret-digest-mismatch",
    "qa-secret-digest-mismatch:OTHER_LIVE_SECRET",
  ]);
});

test("a role failure after the secrets were written is outcome-unknown with rotate guidance", async (t) => {
  for (const [controls, issue] of [
    [{ loginFails: true }, "qa-role-login-failed"],
    [{ probeFails: true }, "qa-role-login-probe-failed"],
    [{ extraFactChange: true }, "qa-role-facts-changed"],
    [{ dropPassword: true }, "qa-role-password-not-scram"],
  ]) {
    const h = await harness(t, { controls });
    const receipt = await h.run();
    assert.equal(receipt.status, "outcome-unknown", issue);
    assert.equal(receipt.issues[0], issue);
    assert.deepEqual(receipt.counts.secrets, { installed: 22 });
    assert.ok(
      receipt.roles.every((item) => item.outcome === "outcome-unknown"),
    );
    assert.match(receipt.recovery, /rotate/);
  }
});

test("an unreadable pg_authid is accepted only because the sign-in probe proves each password", async (t) => {
  const h = await harness(t, { controls: { unreadable: true } });
  assert.equal((await h.run()).status, "verified");
  assert.equal(h.calls.probes.length, 3);
  const failing = await harness(t, {
    controls: { unreadable: true, probeFails: true },
  });
  assert.equal((await failing.run()).issues[0], "qa-role-login-probe-failed");
});

// ── Rotate ─────────────────────────────────────────────────────────────────────────────────────

test("rotate replaces every role URL and password and only differing staged values", async (t) => {
  const store = fullStore({ STILL_QA_SANDBOX_STRIPE_PRICE_ID: "price_old" });
  const old = new Map(Object.entries(store));
  const h = await harness(t, {
    mode: "rotate",
    roles: allLoggedIn(),
    secrets: store,
  });
  const receipt = await h.run();
  assert.equal(receipt.status, "verified", receipt.issues.join());
  assert.deepEqual(
    [...h.calls.posts[0]].sort(),
    [
      ...QA_ROLE_LOGINS.map((item) => item.secret),
      "STILL_QA_SANDBOX_STRIPE_PRICE_ID",
    ].sort(),
  );
  for (const { role, secret } of QA_ROLE_LOGINS) {
    assert.notEqual(h.store.get(secret), old.get(secret));
    const password = new URL(h.store.get(secret)).password;
    assert.ok(verifierAccepts(h.roles.get(role).verifier, password));
  }
  assert.deepEqual(receipt.counts.roles, { "password-rotated": 3 });
  assert.deepEqual(receipt.counts.secrets, { replaced: 4, unchanged: 18 });
  assert.equal(
    outcomes(receipt.secrets).STILL_QA_SANDBOX_STRIPE_PRICE_ID,
    "replaced",
  );
});

// ── Disable ────────────────────────────────────────────────────────────────────────────────────

test("disable switches the QA writer off first, then deletes only QA-prefixed secrets", async (t) => {
  const h = await harness(t, {
    mode: "disable",
    roles: allLoggedIn(),
    secrets: fullStore({ OTHER: "x" }),
  });
  const receipt = await h.run();
  assert.equal(receipt.status, "verified", receipt.issues.join());
  assert.equal(h.calls.deletes.length, 1);
  assert.deepEqual([...h.calls.deletes[0]].sort(), [...DISABLE_SECRETS].sort());
  assert.ok(
    h.calls.deletes[0].every((name) => name.startsWith("STILL_QA_SANDBOX_")),
  );
  assert.ok(h.store.has("SETTINGS_WRITER_DB_URL"));
  assert.ok(h.store.has("PRODUCT_POLICY_READER_DB_URL"));
  assert.ok(h.store.has("OTHER"));
  assert.equal(h.roles.get(WRITER).login, false);
  assert.equal(h.roles.get("still_settings_writer").login, true);
  assert.equal(h.roles.get("still_policy_reader").login, true);
  const order = [
    ...new Set(
      h.snapshots
        .map((item) => item.status)
        .filter((s) => s.startsWith("writing") || s.startsWith("deleting")),
    ),
  ];
  assert.deepEqual(order, ["writing-role", "deleting-secrets"]);
  assert.deepEqual(receipt.connections, { closed: 1, remaining: 0 });
  assert.deepEqual(receipt.counts.secrets, { deleted: 20, kept: 2 });
  assert.deepEqual(outcomes(receipt.roles, "role"), {
    still_policy_reader: "kept",
    still_settings_writer: "kept",
    still_qa_sandbox_writer: "nologin-set",
  });
  assert.equal(h.calls.posts.length, 0);
  assert.ok(!h.calls.exec.some((call) => call.args[0] === "--version"));

  const again = await h.run();
  assert.equal(again.status, "no-change");
  assert.deepEqual(again.counts.secrets, { absent: 20, kept: 2 });
  assert.equal(h.calls.deletes.length, 1);
});

test("disable needs no staged values, tolerates a missing role and records unknown deletes", async (t) => {
  const h = await harness(t, {
    mode: "disable",
    roles: { [WRITER]: { missing: true } },
    secrets: fullStore(),
    controls: { deleteFailure: 500 },
  });
  const receipt = await h.run();
  assert.equal(receipt.status, "outcome-unknown");
  assert.deepEqual(receipt.issues, ["qa-secrets-write-outcome-unknown"]);
  assert.equal(outcomes(receipt.roles, "role")[WRITER], "absent");
  assert.ok(
    receipt.secrets
      .filter((item) => item.name.startsWith("STILL_QA_SANDBOX_"))
      .every((item) => item.outcome === "outcome-unknown"),
  );
  assert.match(receipt.recovery, /disable again \(safe to repeat\)/);
});

// ── Masking ────────────────────────────────────────────────────────────────────────────────────

test("no value, password, verifier or token reaches output, argv, URLs or any receipt", async (t) => {
  const printed = [];
  const originals = {
    out: process.stdout.write,
    err: process.stderr.write,
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };
  process.stdout.write = function (chunk, ...rest) {
    printed.push(String(chunk));
    return originals.out.call(this, chunk, ...rest);
  };
  process.stderr.write = function (chunk, ...rest) {
    printed.push(String(chunk));
    return originals.err.call(this, chunk, ...rest);
  };
  for (const name of ["log", "error", "warn", "info"]) {
    console[name] = (...args) => printed.push(args.map(String).join(" "));
  }
  const runs = [];
  try {
    for (const options of [
      {},
      { controls: { loginFails: true } },
      { controls: { probeFails: true } },
      { controls: { postFailure: 500 } },
      { controls: { corruptDigest: "SETTINGS_WRITER_DB_URL" } },
      {
        secrets: { STILL_QA_SANDBOX_STRIPE_PRICE_ID: "SENTINELEXISTINGVALUE" },
      },
      { mode: "rotate", roles: allLoggedIn(), secrets: fullStore() },
      { mode: "disable", roles: allLoggedIn(), secrets: fullStore() },
    ]) {
      const h = await harness(t, options);
      runs.push({ h, receipt: await h.run() });
    }
  } finally {
    process.stdout.write = originals.out;
    process.stderr.write = originals.err;
    for (const name of ["log", "error", "warn", "info"])
      console[name] = originals[name];
  }
  for (const { h, receipt } of runs) {
    const secrets = [
      ...Object.values(stagedValues()),
      "SENTINEL",
      fakeToken(),
      ADMIN_PASSWORD,
      ...h.generated,
      ...h.calls.verifiers,
      ...[...h.store.values()],
      ...[...h.store.values()].map((value) => sha256(value)),
    ].filter((value) => value.length >= 8);
    const publicText = [
      JSON.stringify(receipt),
      JSON.stringify(h.snapshots),
      renderQaSecretsFinal(receipt),
      renderQaSecretsFinal(null),
      renderQaSecretsPlan(h.plan),
      JSON.stringify(h.plan),
      ...printed,
      ...h.calls.exec.map((call) => JSON.stringify(call.args)),
      ...h.calls.fetch.map((call) => call.url),
    ].join("\n");
    for (const value of secrets) {
      assert.ok(
        !publicText.includes(value),
        "a secret value or its digest leaked",
      );
    }
    // Any 12-character window of a high-entropy value is a partial leak.
    const entropy = [
      ...Object.values(stagedValues()),
      fakeToken(),
      ADMIN_PASSWORD,
      ...h.generated,
      ...h.calls.verifiers.flatMap((verifier) =>
        verifier.split(/[$:]/).slice(2),
      ),
    ];
    for (const value of entropy) {
      for (let i = 0; i + 12 <= value.length; i += 4) {
        assert.ok(
          !publicText.includes(value.slice(i, i + 12)),
          "part of a secret value leaked",
        );
      }
    }
    // Verifiers travel only in psql's environment, and only to the pinned login file.
    for (const call of h.calls.exec) {
      const keys = Object.keys(call.env).filter((key) =>
        key.endsWith("_VERIFIER"),
      );
      if (keys.length) assert.ok(call.args.includes("--single-transaction"));
    }
  }
  assert.ok(runs[0].h.generated.length >= 3);
});

test("closing records without a receipt or after an interrupted write say outcome unknown", () => {
  assert.match(
    renderQaSecretsFinal(null, { applyOutcome: "skipped" }),
    /stopped-before-write/,
  );
  assert.match(renderQaSecretsFinal(null), /Outcome unknown/);
  const text = renderQaSecretsFinal({
    mode: "apply",
    status: "writing-secrets",
    writeAttempted: true,
    secrets: [{ name: "SETTINGS_WRITER_DB_URL", outcome: "outcome-unknown" }],
    roles: [],
    counts: { secrets: { "outcome-unknown": 1 }, roles: {} },
    issues: [],
    recovery: "",
  });
  assert.match(text, /status: outcome-unknown/);
  assert.match(text, /rotate/);
});
