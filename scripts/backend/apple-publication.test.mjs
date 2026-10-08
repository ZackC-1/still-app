import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const funcs = (source) => [
  ...source.matchAll(
    /create(?: or replace)? function\s+([\w.]+)\s*\((.*?)\)\s*returns\s+(\w+)[\s\S]*?as \$\$([\s\S]*?)\$\$;/gis,
  ),
];

test("0020 keeps the retained limiter policy and privacy body, adding only the Apple bucket", () => {
  const before = funcs(
    read("supabase/migrations/0017_analytics_erasure.sql"),
  ).find((m) => m[1] === "public.consume_rate_limit");
  const after = funcs(
    read("supabase/migrations/0020_apple_scoped_access.sql"),
  ).find((m) => m[1] === "public.consume_rate_limit");
  assert.ok(after, "0020 must enable the actual Apple handler's SQL bucket");
  assert.equal(
    after[4].replace(
      "'analytics-identify', 'apple-access'",
      "'analytics-identify'",
    ),
    before[4],
  );
  const handler = read("supabase/functions/_shared/apple-fulfillment.ts");
  for (const kind of ["ip", "user"])
    assert.ok(handler.includes(`apple-access:${kind}:`));
  assert.match(after[4], /'analytics-identify', 'apple-access'/);
  const gate = read(
    "scripts/backend/deploy/verify/0020_apple_scoped_access.sql",
  );
  const md5 = createHash("md5").update(after[4]).digest("hex");
  assert.ok(
    gate.includes(`'${md5}'`),
    "catalog gate binds the new limiter body",
  );
  assert.ok(gate.includes("search_path=pg_catalog, pg_temp"));
  assert.ok(
    gate.includes("still_settings_writer") &&
      gate.includes("still_analytics_eraser"),
  );
});

test("all ten exact routine descriptors bind final migration bodies and argument names", () => {
  const final = new Map();
  for (const version of [
    "0019_scoped_access_rights",
    "0020_apple_scoped_access",
  ]) {
    for (const match of funcs(read(`supabase/migrations/${version}.sql`))) {
      const args = match[2].split(",").map((arg) => arg.trim().split(/\s+/));
      const signature = `${match[1]}(${args.map((arg) => arg[1]).join(",")})`;
      final.set(signature, {
        md5: createHash("md5").update(match[4]).digest("hex"),
        result: match[3],
        names: args.map((arg) => arg[0]),
      });
    }
  }
  assert.equal(final.size, 10);
  const gate = read(
    "scripts/backend/deploy/verify/0020_apple_scoped_access.sql",
  );
  const rows = [
    ...gate.matchAll(
      /\('([^']+\([^']*\))', '([0-9a-f]{32})', '(\w+)', array\[([^\]]+)\]::text\[\]/g,
    ),
  ];
  assert.equal(rows.length, 10);
  for (const [, signature, md5, result, names] of rows) {
    assert.deepEqual(
      {
        md5,
        result,
        names: [...names.matchAll(/'([^']+)'/g)].map((m) => m[1]),
      },
      final.get(signature),
      signature,
    );
  }
  assert.match(
    read("supabase/tests/apple_access_migration_gates_test.ts"),
    /assertEquals\(functions.length, 8\)/,
  );
});

test("upgrade fixture is disjoint from all later same-database ledger keys", () => {
  const gate = read("supabase/tests/apple_access_migration_gates_test.ts");
  const ledger = read("supabase/tests/apple_scoped_access_test.ts");
  const key = gate.match(/key: "([a-f])"\.repeat\(64\)/)[1];
  const keys = [...ledger.matchAll(/"([a-f])"\.repeat\(64\)/g)].map(
    (m) => m[1],
  );
  assert.ok(
    !keys.includes(key),
    "nonempty upgrade fixture cannot pre-own a ledger probe key",
  );
  assert.match(ledger, /synthetic fixture keys already present/);
});

test("ledger fingerprints order by every primary-key column", () => {
  const invariant = read(
    "scripts/backend/deploy/verify/0020_apple_scoped_access.invariant.sql",
  );
  for (const [table, order] of [
    ["access_observations", "r.holder,r.environment"],
    ["access_revocations", "r.holder,r.environment,r.right_id"],
  ]) {
    const line = invariant
      .split("\n")
      .find((l) => l.includes(`'private.${table}'`));
    assert.ok(
      line.replaceAll(/\s/g, "").includes(`orderby${order}`),
      `${table}: complete PK sort`,
    );
  }
});

test("0020 routine gate binds result, kind and extra overload count as well as body", () => {
  const gate = read(
    "scripts/backend/deploy/verify/0020_apple_scoped_access.sql",
  );
  for (const token of [
    "pg_get_function_result",
    "prokind",
    "proretset",
    "routine_overload:",
    "routine_result:",
    "routine_kind:",
  ])
    assert.ok(gate.includes(token), token);
});

for (const file of [
  "apple_access_migration_gates_test.ts",
  "apple_scoped_access_test.ts",
  "access_served_test.ts",
]) {
  test(`required cloud probe ${file} refuses disabled invocation before network`, () => {
    const result = spawnSync(
      "deno",
      [
        "test",
        "--frozen",
        "--config",
        "supabase/functions/deno.json",
        "--allow-env",
        `supabase/tests/${file}`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          STILL_REQUIRE_CLOUD_TESTS: "1",
        },
        timeout: 30000,
      },
    );
    assert.notEqual(
      result.status,
      0,
      "required invocation must not be all ignored",
    );
    assert.match(
      result.stderr + result.stdout,
      /required-cloud-tests-disabled/,
    );
  });
}

test("optional local Apple probes remain ignored and require no database or provider", () => {
  const result = spawnSync(
    "deno",
    [
      "test",
      "--frozen",
      "--config",
      "supabase/functions/deno.json",
      "--allow-env",
      "supabase/tests/apple_access_migration_gates_test.ts",
      "supabase/tests/apple_scoped_access_test.ts",
      "supabase/tests/access_served_test.ts",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 ignored/);
});

test("coherent hosted runner retains0020 upgrade, real ledger and clean gate with mandatory flag", () => {
  const runner = read("scripts/backend/rehearse.sh");
  assert.match(runner, /export STILL_REQUIRE_CLOUD_TESTS=1/);
  assert.match(runner, /db_test_env=--allow-env=STILL_REQUIRE_CLOUD_TESTS,/);
  assert.match(runner, /access_upgrade 0020 0020_apple_scoped_access/);
  assert.match(runner, /supabase\/tests\/apple_scoped_access_test.ts/);
  assert.match(runner, /access_migration_test 0020 post/);
  assert.match(
    runner,
    /if \[\[ "\$1" == 0020 \]\]; then test_file=supabase\/tests\/apple_access_migration_gates_test.ts/,
  );
  assert.match(
    read("scripts/backend/rehearse-access.sh"),
    /export STILL_REQUIRE_CLOUD_TESTS=1/,
  );
});

test("every0020SECURITYDEFINER keeps the maintained0015+ catalog/pg_temp-last contract", () => {
  const maintained = read("supabase/tests/server_rpc_grants_test.ts");
  assert.match(
    maintained,
    /const pinned = history.has0015[\s\S]*?"search_path=pg_catalog, pg_temp"/,
  );
  const gate = read(
    "scripts/backend/deploy/verify/0020_apple_scoped_access.sql",
  );
  const paths = [...gate.matchAll(/'search_path=([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(paths, Array(10).fill("pg_catalog, pg_temp"));
  const migration = read("supabase/migrations/0020_apple_scoped_access.sql");
  const routines = funcs(migration);
  assert.equal(routines.length, 8);
  for (const routine of routines) {
    const header = routine[0].slice(0, routine[0].indexOf("as $$"));
    assert.match(
      header,
      /security definer\s+set search_path\s*=\s*pg_catalog,\s*pg_temp\s*$/i,
      routine[1],
    );
    // The search-path policy is safe only when relation targets remain explicitly scoped.
    const querySource = routine[4]
      .replace(/--[^\n]*/g, "")
      .replace(/'(?:''|[^'])*'/g, "''")
      .replace(/\bis(?:\s+not)?\s+distinct\s+from\b/gi, "is distinct")
      .replace(/\bextract\([^)]*\)/gi, "extract()");
    const relations = [
      ...querySource.matchAll(
        /\b(?:from|join|update|insert into|delete from)\s+([\w.]+)(\s*\()?/gi,
      ),
    ];
    for (const [, name, call] of relations) {
      if (call?.includes("(") || name === "set") continue;
      assert.match(
        name,
        /^(private|public|auth|pg_catalog)\./,
        `${routine[1]}: relation ${name} must be schema-qualified`,
      );
    }
  }
});
