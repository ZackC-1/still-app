// Structural guards for .github/workflows/release-chrome.yml. They parse the real YAML; they do not
// prove GitHub's or Google's runtime behaviour (the owner's approval rules and Google's trust rule do
// that). Each guard is checked against a deliberately broken copy too, so a guard that can never fail
// is caught.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { parsers } from "prettier/plugins/yaml";
import { PUBLIC_ENV_KEYS } from "./package.mjs";

const WORKFLOWS = new URL("../../.github/workflows/", import.meta.url);
const FILE = "release-chrome.yml";
const PINNED = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;
const AUTH = "google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093";

// Same plain-data YAML reader as scripts/backend/deploy/deploy-workflow.test.mjs: no anchors, no tags.
function value(node) {
  assert.equal(node.anchor ?? null, null);
  assert.equal(node.tag ?? null, null);
  if (node.type === "mapping" || node.type === "flowMapping") return Object.fromEntries(node.children.map(({ children: [k, v] }) => [value(k), value(v)]));
  if (node.type === "sequence" || node.type === "flowSequence") return node.children.map(value);
  if (["plain", "quoteDouble", "quoteSingle", "blockLiteral", "blockFolded"].includes(node.type)) return node.value;
  if (["mappingKey", "mappingValue", "sequenceItem", "flowSequenceItem", "documentBody"].includes(node.type)) {
    assert.ok(node.children.length <= 1);
    return node.children.length ? value(node.children[0]) : null;
  }
  assert.fail(`Unsupported workflow node: ${node.type}`);
}

async function parse(text) {
  return value((await parsers.yaml.parse(text)).children[0].children[1]);
}

async function load() {
  const text = await readFile(new URL(FILE, WORKFLOWS), "utf8");
  return { text, workflow: await parse(text) };
}

const steps = (job) => job.steps ?? [];
const runText = (job) => steps(job).map((s) => s.run ?? "").join("\n");
const authSteps = (job) => steps(job).filter((s) => String(s.uses ?? "").startsWith("google-github-actions/auth@"));

// ---- the checks, each a function of (text, workflow) so they can also run on broken copies ----

const checks = {
  "starts only by hand": (_t, w) => {
    assert.deepEqual(Object.keys(w.on), ["workflow_dispatch"]);
    assert.equal(w.on.workflow_dispatch.inputs.mode.default, "package-only");
    assert.deepEqual(w.on.workflow_dispatch.inputs.mode.options, ["package-only", "status", "upload", "upload-and-submit"]);
  },
  "no default token permissions; serialized runs": (_t, w) => {
    assert.deepEqual(w.permissions, {});
    assert.deepEqual(w.concurrency, { group: "release-chrome", "cancel-in-progress": "false" });
  },
  "every job asserts main and manual start": (_t, w) => {
    for (const job of Object.values(w.jobs)) {
      assert.match(job.if, /github\.event_name == 'workflow_dispatch'/);
      assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
      assert.match(steps(job)[0].run, /test "\$GITHUB_REF" = refs\/heads\/main/);
    }
  },
  "only the store job may request an identity token": (_t, w) => {
    assert.deepEqual(Object.keys(w.jobs).sort(), ["package", "store"]);
    assert.deepEqual(w.jobs.package.permissions, { contents: "read" });
    assert.deepEqual(w.jobs.store.permissions, { contents: "read", actions: "read", "id-token": "write" });
    assert.match(w.jobs.store.if, /inputs\.mode != 'package-only'/);
    assert.equal(w.jobs.store.needs, "package");
  },
  "both jobs wait for the owner in chrome-release": (_t, w) => {
    assert.equal(w.jobs.package.environment, "chrome-release");
    assert.equal(w.jobs.store.environment, "chrome-release");
  },
  "the build job never sees Chrome identifiers or Google sign-in": (_t, w) => {
    const json = JSON.stringify(w.jobs.package);
    assert.ok(!json.includes("vars.CWS_"), "CWS variable in build job");
    assert.equal(authSteps(w.jobs.package).length, 0);
    const buildEnv = steps(w.jobs.package).find((s) => s.id === "package").env;
    assert.deepEqual(Object.keys(buildEnv).sort(), [...PUBLIC_ENV_KEYS].sort());
    for (const key of PUBLIC_ENV_KEYS) assert.equal(buildEnv[key], `\${{ vars.${key} }}`);
  },
  "no secret, key file or OAuth refresh token anywhere (keyless only)": (t) => {
    for (const forbidden of ["secrets.", "credentials_json", "client_secret", "refresh_token", "private_key", "GOOGLE_APPLICATION_CREDENTIALS", "workload_identity_provider: projects/", "cloud-platform"]) assert.ok(!t.includes(forbidden), forbidden);
  },
  "every action is pinned to a full commit": (_t, w) => {
    for (const job of Object.values(w.jobs)) for (const s of steps(job)) if (s.uses) assert.match(s.uses, PINNED, s.uses);
  },
  "sign-in: read-only first, write only after the store check, short-lived, nothing written to disk": (_t, w) => {
    const store = steps(w.jobs.store);
    const auths = authSteps(w.jobs.store);
    assert.equal(auths.length, 2);
    for (const a of auths) {
      assert.equal(a.uses, AUTH);
      assert.equal(a.with.token_format, "access_token");
      assert.equal(a.with.create_credentials_file, "false");
      assert.equal(a.with.export_environment_variables, "false");
      assert.equal(a.with.workload_identity_provider, "${{ vars.CWS_WORKLOAD_IDENTITY_PROVIDER }}");
      assert.equal(a.with.service_account, "${{ vars.CWS_SERVICE_ACCOUNT }}");
      assert.ok(!("credentials_json" in a.with) && !("audience" in a.with) && !("access_token_subject" in a.with));
    }
    const [read, write] = auths;
    assert.deepEqual([read.id, read.with.access_token_scopes, read.with.access_token_lifetime], ["auth-read", "https://www.googleapis.com/auth/chromewebstore.readonly", "300s"]);
    assert.deepEqual([write.id, write.with.access_token_scopes, write.with.access_token_lifetime], ["auth-write", "https://www.googleapis.com/auth/chromewebstore", "900s"]);
    const at = (pred) => store.findIndex(pred);
    const protection = at((s) => /chrome-release\.mjs protection/.test(s.run ?? ""));
    const verify = at((s) => /chrome-release\.mjs verify-artifact/.test(s.run ?? ""));
    const preflight = at((s) => s.id === "preflight");
    assert.ok(protection > 0 && verify > protection && store.indexOf(read) > verify && preflight > store.indexOf(read) && store.indexOf(write) > preflight, "order");
    assert.match(write.if, /steps\.preflight\.outputs\.action == 'proceed'/);
  },
  "the token reaches only the three store steps, through env": (t, w) => {
    const store = steps(w.jobs.store);
    const users = store.filter((s) => JSON.stringify(s).includes("outputs.access_token"));
    assert.deepEqual(users.map((s) => s.name), ["Read the store's version and decide (read-only)", "Upload the package as a draft", "Submit for Google's review"]);
    assert.equal(users[0].env.CWS_ACCESS_TOKEN, "${{ steps.auth-read.outputs.access_token }}");
    for (const s of users.slice(1)) assert.equal(s.env.CWS_ACCESS_TOKEN, "${{ steps.auth-write.outputs.access_token }}");
    for (const s of users) {
      assert.ok(!(s.run ?? "").includes("access_token"), "token in run text");
      assert.deepEqual(Object.keys(s.env).sort(), ["CWS_ACCESS_TOKEN", "CWS_EXTENSION_ID", "CWS_PUBLISHER_ID"]);
    }
    assert.ok(!JSON.stringify(w.jobs.store.outputs ?? {}).includes("token"));
    assert.ok(!t.includes("auth_token"), "the federated token output is never used");
    assert.ok(!JSON.stringify(w.jobs.store.env).includes("CWS_"), "Chrome identifiers are step-scoped, not job-wide");
  },
  "submit needs upload-and-submit and a successful upload in this run": (_t, w) => {
    const submit = steps(w.jobs.store).find((s) => /chrome-release\.mjs submit/.test(s.run ?? ""));
    assert.equal(submit.if, "inputs.mode == 'upload-and-submit' && steps.upload.outputs.uploaded == 'true'");
    const upload = steps(w.jobs.store).find((s) => s.id === "upload");
    assert.match(upload.if, /inputs\.mode == 'upload' \|\| inputs\.mode == 'upload-and-submit'/);
  },
  "inputs reach scripts only through environment variables": (t, w) => {
    for (const job of Object.values(w.jobs)) {
      const run = runText(job);
      assert.ok(!/\$\{\{/.test(run), `expression inside run: ${run.match(/.*\$\{\{.*/)?.[0]}`);
    }
    assert.ok(!t.includes("github.event."));
  },
  "nothing silences failures or turns on debug output": (t) => {
    for (const forbidden of ["continue-on-error", "set -x", "ACTIONS_STEP_DEBUG", "ACTIONS_RUNNER_DEBUG", "::stop-commands::"]) assert.ok(!t.includes(forbidden), forbidden);
  },
  "checkouts keep no credentials and use the dispatched main commit": (_t, w) => {
    for (const job of Object.values(w.jobs)) {
      const co = steps(job).filter((s) => String(s.uses).startsWith("actions/checkout@"));
      assert.equal(co.length, 1);
      assert.equal(co[0].with["persist-credentials"], "false");
      assert.equal(co[0].with.ref, "${{ github.sha }}");
    }
  },
  "the store job installs nothing from npm": (_t, w) => {
    const run = runText(w.jobs.store);
    for (const forbidden of ["pnpm", "npm ", "npx", "yarn", "corepack", "package.mjs", "chrome-package.mjs"]) assert.ok(!run.includes(forbidden), forbidden);
    assert.ok(steps(w.jobs.store).every((s) => !s.run || /^node scripts\/release\/chrome-release\.mjs [a-z-]+( --dir "\$RUNNER_TEMP\/chrome-release")?$/.test(s.run.trim()) || s === steps(w.jobs.store)[0]));
  },
  "Chrome identifiers are checked in their own step before the first sign-in": (_t, w) => {
    const store = steps(w.jobs.store);
    const check = store.findIndex((s) => (s.run ?? "").trim() === "node scripts/release/chrome-release.mjs check-ids");
    const firstAuth = store.findIndex((s) => String(s.uses ?? "").startsWith("google-github-actions/auth@"));
    assert.ok(check > 0 && check < firstAuth, "check-ids must come before the first sign-in");
    assert.deepEqual(store[check].env, { CWS_PUBLISHER_ID: "${{ vars.CWS_PUBLISHER_ID }}", CWS_EXTENSION_ID: "${{ vars.CWS_EXTENSION_ID }}" });
    assert.equal(store[check].if, undefined, "the check always runs");
  },
  "exact Node version in both jobs": (_t, w) => {
    const versions = Object.values(w.jobs).map((job) => steps(job).find((s) => String(s.uses).startsWith("actions/setup-node@")).with["node-version"]);
    assert.equal(new Set(versions).size, 1);
    assert.match(versions[0], /^\d+\.\d+\.\d+$/);
  },
};

for (const [name, check] of Object.entries(checks)) {
  test(`release-chrome workflow: ${name}`, async () => {
    const { text, workflow } = await load();
    check(text, workflow);
  });
}

test("the workflow lives at the exact path Google's trust rule names, and calls no other workflow", async () => {
  const names = await readdir(WORKFLOWS);
  assert.ok(names.includes(FILE));
  const { text } = await load();
  assert.ok(!text.includes("uses: ./"), "local or reusable workflow");
  assert.ok(!/workflow_call|repository_dispatch|pull_request|schedule:|push:/.test(text));
});

test("no other workflow can reach chrome-release, its variables or the Chrome API", async () => {
  for (const name of await readdir(WORKFLOWS)) {
    if (name === FILE || !/\.ya?ml$/.test(name)) continue;
    const text = await readFile(new URL(name, WORKFLOWS), "utf8");
    for (const forbidden of ["chrome-release", "vars.CWS_", "chromewebstore", "google-github-actions/auth"]) assert.ok(!text.includes(forbidden), `${name} mentions ${forbidden}`);
  }
});

// ---- negative controls: each guard must fail on a copy broken in the way it guards against ----

const BREAKS = [
  ["starts only by hand", (t) => t.replace("on:\n  workflow_dispatch:", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:")],
  ["starts only by hand", (t) => t.replace("default: package-only", "default: upload")],
  ["no default token permissions; serialized runs", (t) => t.replace("permissions: {}", "permissions:\n  contents: write")],
  ["no default token permissions; serialized runs", (t) => t.replace("cancel-in-progress: false", "cancel-in-progress: true")],
  ["every job asserts main and manual start", (t) => t.replace("if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'\n    runs-on", "if: github.event_name == 'workflow_dispatch'\n    runs-on")],
  ["only the store job may request an identity token", (t) => t.replace("    permissions:\n      contents: read\n    outputs:", "    permissions:\n      contents: read\n      id-token: write\n    outputs:")],
  ["only the store job may request an identity token", (t) => t.replace(" && inputs.mode != 'package-only'", "")],
  ["both jobs wait for the owner in chrome-release", (t) => t.replace("    # The owner approves this job separately. Only after that does it see the Chrome identifiers.\n    environment: chrome-release\n", "")],
  ["the build job never sees Chrome identifiers or Google sign-in", (t) => t.replace("          VITE_POSTHOG_HOST: ${{ vars.VITE_POSTHOG_HOST }}", "          VITE_POSTHOG_HOST: ${{ vars.VITE_POSTHOG_HOST }}\n          CWS_PUBLISHER_ID: ${{ vars.CWS_PUBLISHER_ID }}")],
  ["no secret, key file or OAuth refresh token anywhere (keyless only)", (t) => t.replace("          create_credentials_file: false\n          export_environment_variables: false\n      - name: Read", "          create_credentials_file: false\n          export_environment_variables: false\n          credentials_json: ${{ secrets.CWS_KEY }}\n      - name: Read")],
  ["no secret, key file or OAuth refresh token anywhere (keyless only)", (t) => t.replace("access_token_scopes: https://www.googleapis.com/auth/chromewebstore\n", "access_token_scopes: https://www.googleapis.com/auth/cloud-platform\n")],
  ["every action is pinned to a full commit", (t) => t.replace(AUTH, "google-github-actions/auth@v3")],
  ["sign-in: read-only first, write only after the store check, short-lived, nothing written to disk", (t) => t.replace("access_token_scopes: https://www.googleapis.com/auth/chromewebstore.readonly", "access_token_scopes: https://www.googleapis.com/auth/chromewebstore")],
  ["sign-in: read-only first, write only after the store check, short-lived, nothing written to disk", (t) => t.replace("access_token_lifetime: 900s", "access_token_lifetime: 3600s")],
  ["sign-in: read-only first, write only after the store check, short-lived, nothing written to disk", (t) => t.replace("create_credentials_file: false", "create_credentials_file: true")],
  ["sign-in: read-only first, write only after the store check, short-lived, nothing written to disk", (t) => t.replace(" && steps.preflight.outputs.action == 'proceed'\n        uses:", "\n        uses:")],
  ["the token reaches only the three store steps, through env", (t) => t.replace("run: node scripts/release/chrome-release.mjs receipt", "run: echo \"${CWS_ACCESS_TOKEN}\" && node scripts/release/chrome-release.mjs receipt").replace("          JOB_STATUS: ${{ job.status }}", "          JOB_STATUS: ${{ job.status }}\n          CWS_ACCESS_TOKEN: ${{ steps.auth-write.outputs.access_token }}")],
  ["the token reaches only the three store steps, through env", (t) => t.replace("      PACKAGE_ZIP_SHA256: ${{ needs.package.outputs.zip-sha256 }}", "      PACKAGE_ZIP_SHA256: ${{ needs.package.outputs.zip-sha256 }}\n      CWS_PUBLISHER_ID: ${{ vars.CWS_PUBLISHER_ID }}")],
  ["submit needs upload-and-submit and a successful upload in this run", (t) => t.replace("if: inputs.mode == 'upload-and-submit' && steps.upload.outputs.uploaded == 'true'", "if: steps.upload.outputs.uploaded == 'true'")],
  ["inputs reach scripts only through environment variables", (t) => t.replace('run: node scripts/release/chrome-package.mjs --out "$RUNNER_TEMP/chrome-package"', 'run: node scripts/release/chrome-package.mjs --out "$RUNNER_TEMP/${{ inputs.version }}"')],
  ["nothing silences failures or turns on debug output", (t) => t.replace("        id: upload\n", "        id: upload\n        continue-on-error: true\n")],
  ["checkouts keep no credentials and use the dispatched main commit", (t) => t.replace("persist-credentials: false", "persist-credentials: true")],
  ["checkouts keep no credentials and use the dispatched main commit", (t) => t.replace("ref: ${{ github.sha }}", "ref: ${{ inputs.commit }}")],
  ["the store job installs nothing from npm", (t) => t.replace("run: node scripts/release/chrome-release.mjs protection", "run: pnpm install && node scripts/release/chrome-release.mjs protection")],
  ["Chrome identifiers are checked in their own step before the first sign-in", (t) => t.replace("      - name: Check the Chrome identifiers before any sign-in\n        env:\n          CWS_PUBLISHER_ID: ${{ vars.CWS_PUBLISHER_ID }}\n          CWS_EXTENSION_ID: ${{ vars.CWS_EXTENSION_ID }}\n        run: node scripts/release/chrome-release.mjs check-ids\n", "")],
  ["exact Node version in both jobs", (t) => t.replace('node-version: "22.23.3"', 'node-version: "22"')],
];

test("every workflow guard fails on a copy broken the way it guards against", async () => {
  const { text } = await load();
  for (const [name, breakIt] of BREAKS) {
    const broken = breakIt(text);
    assert.notEqual(broken, text, `break for "${name}" did not apply`);
    // The intact file passes this guard...
    checks[name](text, await parse(text));
    // ...and the broken copy does not.
    let failed = false;
    try {
      checks[name](broken, await parse(broken));
    } catch {
      failed = true;
    }
    assert.ok(failed, `guard "${name}" did not catch its break`);
  }
});
