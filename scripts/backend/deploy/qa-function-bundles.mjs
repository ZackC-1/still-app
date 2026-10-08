import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonical, hash } from "../plan.mjs";
import { defaultExec } from "./deploy.mjs";

export const DENO_VERSION = "2.8.3";
export const QA_FUNCTIONS = Object.freeze([
  ["qa-sandbox-product-policy", false],
  ["qa-sandbox-sync-settings", true],
  ["qa-sandbox-reconcile-entitlement", true],
  ["qa-sandbox-verify-apple-access", false],
  ["qa-sandbox-link-apple-access", true],
  ["qa-sandbox-create-web-checkout", true],
  ["qa-sandbox-complete-web-checkout", true],
  ["qa-sandbox-stripe-webhook", false],
].map(([name, verifyJwt]) => Object.freeze({ name, verifyJwt })));

const CONFIG = "supabase/functions/deno.json";
const LOCK = "supabase/functions/deno.lock";
const FLAGS = Object.freeze([
  "--config",
  CONFIG,
  "--lock",
  LOCK,
  "--frozen-lockfile",
  "--node-modules-dir=none",
  "--platform=deno",
  "--format=esm",
  "--minify",
]);
const TOOLING = [
  "scripts/backend/deploy/qa-function-bundles.mjs",
  "scripts/backend/deploy/deploy.mjs",
  "scripts/backend/plan.mjs",
];
const same = (a, b) => canonical(a) === canonical(b);
const refuse = (message) => {
  throw new Error(message);
};

const REQUIRE_IMPORT =
  'import{createRequire as __deno_internal_createRequire} from "node:module";';
const SEALED_REQUIRE =
  `import { createRequire as __still_qa_create_require, isBuiltin as __still_qa_is_builtin } from "node:module";
var __deno_internal_createRequire = (url) => {
  const load = __still_qa_create_require(url);
  return (specifier) => {
    if (typeof specifier !== "string" || !specifier.startsWith("node:") || !__still_qa_is_builtin(specifier)) {
      throw new Error("Unbound QA runtime require");
    }
    return load(specifier);
  };
};
`;

// Deno's ESM graph does not include CommonJS optional require('encoding') in
// node-fetch. Seal its generated loader so runtime discovery cannot add source
// beyond the uploaded bytes. Accept only the characterized pinned prologue.
export function sealRuntimeRequires(source) {
  if (!source.includes("createRequire")) return source;
  const start = source.indexOf(REQUIRE_IMPORT);
  const end = start + REQUIRE_IMPORT.length;
  const loader = source.slice(end, source.indexOf(";", end) + 1);
  const factory =
    /^var [A-Za-z_$][A-Za-z0-9_$]*=__deno_internal_createRequire\(import\.meta\.url\);$/;
  if (
    start < 0 || !factory.test(loader) ||
    (source.slice(0, start) + source.slice(end + loader.length)).includes(
      "createRequire",
    ) ||
    source.includes("__still_qa_")
  ) {
    refuse("Unrecognized CommonJS compiler prologue");
  }
  return source.slice(0, start) + SEALED_REQUIRE + source.slice(end);
}

// Check every component, not only the leaf: an ancestor symlink can escape an
// otherwise relative repository path. The caller owns an isolated source tree.
async function regularFile(root, path) {
  if (
    !path || path.startsWith("/") ||
    path.split("/").some((p) => p === ".." || p === "." || !p)
  ) {
    refuse("Unbound source path");
  }
  let current = resolve(root);
  for (const component of path.split("/")) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      refuse("Symlinked source or upload");
    }
  }
  if (!(await lstat(current)).isFile()) {
    refuse("Source or upload is not a regular file");
  }
  return current;
}

async function run(exec, args, cwd) {
  const result = await exec("deno", args, { cwd });
  if (result.code !== 0) refuse(`Deno ${args[0]} failed`);
  return result.stdout;
}

async function toolchain(exec, cwd) {
  const identity = (await run(exec, ["--version"], cwd)).trim();
  if (
    !new RegExp(
      `^deno ${
        DENO_VERSION.replaceAll(".", "\\.")
      } \\([^\\n]+\\)\\nv8 [^\\n]+\\ntypescript [^\\n]+$`,
    ).test(identity)
  ) {
    refuse(`Deno ${DENO_VERSION} is required`);
  }
  return {
    identity,
    flags: [...FLAGS],
    runtimeRequire: "node-builtins-only-v1",
  };
}

function checkConfig(text) {
  // Only interpret the closed route sections and their two required settings;
  // duplicates and unfamiliar values are rejected rather than guessed.
  for (const { name, verifyJwt } of QA_FUNCTIONS) {
    const sections = [...text.matchAll(/^\s*\[([^\]\n]+)\]\s*(?:#.*)?$/gm)];
    const matches = sections.filter((section) =>
      section[1] === `functions.${name}`
    );
    if (matches.length !== 1) {
      refuse("Missing or duplicate fixed QA function configuration");
    }
    const start = matches[0].index + matches[0][0].length;
    const next = sections.find((section) => section.index >= start);
    const body = text.slice(start, next?.index ?? text.length);
    const jwt = [
      ...body.matchAll(/^\s*verify_jwt\s*=\s*(true|false)\s*(?:#.*)?$/gm),
    ];
    if (jwt.length !== 1 || jwt[0][1] !== String(verifyJwt)) {
      refuse(`QA JWT configuration differs: ${name}`);
    }
    const maps = [
      ...body.matchAll(/^\s*import_map\s*=\s*"([^"\n]+)"\s*(?:#.*)?$/gm),
    ];
    if (maps.length !== 1 || maps[0][1] !== `./functions/${name}/deno.json`) {
      refuse("Unbound QA import map");
    }
  }
}

function checkGraph(graph, rootSpecifier) {
  if (
    !graph || !same(graph.roots, [rootSpecifier]) ||
    !Array.isArray(graph.modules) || !graph.modules.length || graph.error
  ) {
    refuse("Invalid or unresolved dependency graph");
  }
  const resolved = new Set(graph.modules.map((module) => module.specifier));
  if (!resolved.has(rootSpecifier)) refuse("Unbound dependency graph root");
  const redirects = graph.redirects ?? {};
  for (const module of graph.modules) {
    if (module.error) refuse("Unresolved dependency graph module");
    for (const dependency of module.dependencies ?? []) {
      for (const edge of [dependency.code, dependency.type].filter(Boolean)) {
        if (edge.error || !edge.specifier) {
          refuse("Unresolved dependency graph edge");
        }
        let target = edge.specifier;
        const visited = new Set();
        while (redirects[target]) {
          if (visited.has(target)) refuse("Cyclic dependency graph redirect");
          visited.add(target);
          target = redirects[target];
        }
        if (!resolved.has(target)) refuse("Unbound dependency graph edge");
      }
    }
  }
}

async function sourceClosure(sourceDir, exec) {
  const paths = new Set(["supabase/config.toml", CONFIG, LOCK, ...TOOLING]);
  for (const { name } of QA_FUNCTIONS) {
    paths.add(`supabase/functions/${name}/deno.json`);
    paths.add(`supabase/functions/${name}/index.ts`);
  }
  for (const path of paths) await regularFile(sourceDir, path);
  checkConfig(await readFile(join(sourceDir, "supabase/config.toml"), "utf8"));
  const lock = JSON.parse(await readFile(join(sourceDir, LOCK), "utf8"));
  for (const { name } of QA_FUNCTIONS) {
    const entry = `supabase/functions/${name}/index.ts`;
    const graph = JSON.parse(
      await run(exec, [
        "info",
        "--json",
        "--config",
        CONFIG,
        "--lock",
        LOCK,
        "--frozen",
        "--node-modules-dir=none",
        entry,
      ], sourceDir),
    );
    checkGraph(graph, pathToFileURL(join(sourceDir, entry)).href);
    const packages = new Set();
    for (const module of graph.modules) {
      if (module.specifier.startsWith("file:")) {
        const path = relative(sourceDir, fileURLToPath(module.specifier));
        if (
          !/^(supabase\/functions\/|packages\/(core|shared-types)\/src\/)/.test(
            path,
          ) || module.local !== join(sourceDir, path)
        ) {
          refuse("Dependency graph source outside reviewed runtime tree");
        }
        await regularFile(sourceDir, path);
        paths.add(path);
      } else if (
        module.kind === "node" && module.specifier.startsWith("node:") &&
        isBuiltin(module.specifier)
      ) {
        continue;
      } else if (module.kind === "npm" && module.npmPackage) {
        packages.add(module.npmPackage);
      } else {
        refuse("Unbound external source dependency");
      }
    }
    // Deno reports package modules rather than every npm file. Frozen lock
    // integrity pins each package and its transitive dependencies before bundling.
    for (const id of packages) {
      const pkg = graph.npmPackages?.[id];
      if (
        !pkg || !lock.npm?.[id]?.integrity ||
        pkg.registryUrl !== "https://registry.npmjs.org/"
      ) {
        refuse("Unbound npm dependency integrity");
      }
      for (const dependency of pkg.dependencies ?? []) packages.add(dependency);
    }
  }
  return Promise.all(
    [...paths].sort().map(async (path) => ({
      path,
      sha256: hash(await readFile(await regularFile(sourceDir, path))),
    })),
  );
}

async function closedUpload(artifactDir, file, exec) {
  const path = await regularFile(artifactDir, file);
  const graph = JSON.parse(
    await run(
      exec,
      ["info", "--no-config", "--no-lock", "--json", path],
      artifactDir,
    ),
  );
  const root = pathToFileURL(path).href;
  checkGraph(graph, root);
  if (
    Object.keys(graph.redirects ?? {}).length ||
    graph.modules.some((module) =>
      module.specifier === root
        ? module.kind !== "esm" || module.local !== path
        : module.kind !== "node" || !module.specifier.startsWith("node:") ||
          !isBuiltin(module.specifier)
    )
  ) refuse("Upload bundle has an external or unbound runtime module");
  const bytes = await readFile(path);
  if (!bytes.length) refuse("Empty upload bundle");
  return { sha256: hash(bytes), bytes: bytes.length };
}

async function artifactInventory(artifactDir, expected) {
  if (await realpath(artifactDir) !== artifactDir) {
    refuse("Symlinked artifact directory");
  }
  const actual = (await readdir(artifactDir)).sort();
  if (!same(actual, [...expected].sort())) {
    refuse("Upload artifact inventory differs");
  }
}

/** Compile all fixed QA routes. No remote deployment or provider calls occur. */
export async function buildQaFunctionBundles(
  { sourceDir, artifactDir, exec = defaultExec },
) {
  sourceDir = resolve(sourceDir);
  artifactDir = resolve(artifactDir);
  if (await realpath(sourceDir) !== sourceDir) {
    refuse("Symlinked source directory");
  }
  if (relative(sourceDir, artifactDir).split("/")[0] !== "..") {
    refuse("Uploads must be outside the source tree");
  }
  const compiler = await toolchain(exec, sourceDir);
  const sources = await sourceClosure(sourceDir, exec);
  await mkdir(artifactDir, { recursive: true });
  await artifactInventory(artifactDir, []);
  const functions = [];
  for (const { name, verifyJwt } of QA_FUNCTIONS) {
    const file = `${name}.js`;
    await run(exec, [
      "bundle",
      ...FLAGS,
      `--output=${join(artifactDir, file)}`,
      `supabase/functions/${name}/index.ts`,
    ], sourceDir);
    await writeFile(
      join(artifactDir, file),
      sealRuntimeRequires(
        await readFile(await regularFile(artifactDir, file), "utf8"),
      ),
    );
    functions.push({
      name,
      verifyJwt,
      file,
      ...await closedUpload(artifactDir, file, exec),
    });
  }
  const manifest = {
    protocol: 1,
    kind: "still-qa-function-bundles",
    toolchain: compiler,
    sources,
    functions,
  };
  await verifyQaFunctionBundles({ sourceDir, artifactDir, manifest, exec });
  return manifest;
}

/** Recheck a caller-bound manifest against current sources and sealed uploads. */
export async function verifyQaFunctionBundles(
  { sourceDir, artifactDir, manifest, exec = defaultExec },
) {
  sourceDir = resolve(sourceDir);
  artifactDir = resolve(artifactDir);
  if (await realpath(sourceDir) !== sourceDir) {
    refuse("Symlinked source directory");
  }
  if (
    !manifest ||
    !same(Object.keys(manifest).sort(), [
      "functions",
      "kind",
      "protocol",
      "sources",
      "toolchain",
    ]) ||
    manifest.protocol !== 1 || manifest.kind !== "still-qa-function-bundles" ||
    !same(
      manifest.functions?.map(({ name, verifyJwt, file }) => ({
        name,
        verifyJwt,
        file,
      })),
      QA_FUNCTIONS.map((route) => ({ ...route, file: `${route.name}.js` })),
    )
  ) refuse("Invalid fixed QA bundle manifest");
  if (!same(await toolchain(exec, sourceDir), manifest.toolchain)) {
    refuse("Deno toolchain identity drift");
  }
  if (!same(await sourceClosure(sourceDir, exec), manifest.sources)) {
    refuse("QA source closure or hash drift");
  }
  await artifactInventory(
    artifactDir,
    manifest.functions.map(({ file }) => file),
  );
  for (const route of manifest.functions) {
    const actual = await closedUpload(artifactDir, route.file, exec);
    if (
      !same(route, {
        ...QA_FUNCTIONS.find(({ name }) => name === route.name),
        file: route.file,
        ...actual,
      })
    ) {
      refuse("QA upload bundle bytes or metadata drift");
    }
  }
  return true;
}
