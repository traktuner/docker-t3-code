import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const helper = path.join(root, "scripts", "run-config-bootstrap.sh");
const entrypoint = fs.readFileSync(path.join(root, "scripts/entrypoint.sh"), "utf8");
const worker = fs.readFileSync(path.join(root, "scripts/issue-worker-entrypoint.sh"), "utf8");

function run(scope, env) {
  return () => execFileSync("bash", [helper, scope], { env: { ...process.env, ...env } });
}

test("bootstrap is a no-op when unset", () => {
  assert.doesNotThrow(run("container", { T3_CONFIG_BOOTSTRAP: "" }));
});

test("bootstrap invokes the operator script with its scope", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bootstrap-"));
  const log = path.join(directory, "calls");
  const script = path.join(directory, "bootstrap.sh");
  fs.writeFileSync(script, `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >> ${JSON.stringify(log)}\n`);
  assert.doesNotThrow(run("container", { T3_CONFIG_BOOTSTRAP: script }));
  assert.doesNotThrow(run("issue-worker", { T3_CONFIG_BOOTSTRAP: script }));
  assert.equal(fs.readFileSync(log, "utf8"), "container\nissue-worker\n");
});

test("bootstrap fails closed for missing or failing scripts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bootstrap-fail-"));
  assert.throws(run("container", { T3_CONFIG_BOOTSTRAP: path.join(directory, "missing.sh") }));
  const failing = path.join(directory, "failing.sh");
  fs.writeFileSync(failing, "#!/usr/bin/env bash\nexit 23\n");
  assert.throws(run("container", { T3_CONFIG_BOOTSTRAP: failing }));
});

test("container entrypoint places bootstrap before MCP reconciliation and startup", () => {
  const mainMcp = entrypoint.indexOf("provision-harness-mcp.sh");
  const mainBootstrap = entrypoint.indexOf("run-config-bootstrap.sh container");
  assert.ok(mainBootstrap >= 0 && mainBootstrap < mainMcp);
  assert.ok(mainBootstrap < entrypoint.indexOf("\nstart_managed_opencode_server\n"));
});

test("issue worker skips legacy config sync and dependency install during bootstrap", () => {
  const bootstrapBranch = worker.indexOf('if [[ -n "${T3_CONFIG_BOOTSTRAP:-}" ]]; then');
  const legacySourceCheck = worker.indexOf('[[ -d "$config_source" ]] || {');
  const legacyRsync = worker.indexOf("rsync -rlpt --delete");
  const dependencyInstall = worker.indexOf("npm install --prefix");
  const bootstrapCall = worker.indexOf("run-config-bootstrap.sh issue-worker");
  const agentInstall = worker.indexOf("github-issue-worker-agent.md");
  const sandboxInstall = worker.indexOf("t3-sandbox-instructions.md");

  assert.ok(bootstrapBranch >= 0);
  assert.ok(bootstrapCall > bootstrapBranch);
  assert.ok(legacySourceCheck > bootstrapCall);
  assert.ok(legacyRsync > legacySourceCheck);
  assert.ok(dependencyInstall > legacyRsync);
  assert.match(worker.slice(bootstrapBranch, legacySourceCheck), /else/);
  assert.match(worker.slice(bootstrapBranch, dependencyInstall), /T3_CONFIG_BOOTSTRAP/);
  assert.ok(agentInstall > bootstrapCall);
  assert.ok(sandboxInstall > bootstrapCall);
  assert.ok(worker.indexOf("provision-opencode-mcp.mjs") > bootstrapCall);
  assert.ok(worker.indexOf("github-issue-worker.mjs") > worker.indexOf("provision-opencode-mcp.mjs"));
});

test("issue worker preserves legacy config sync and dependency install when bootstrap is unset", () => {
  const legacyBlock = worker.slice(
    worker.indexOf('else\n', worker.indexOf('if [[ -n "${T3_CONFIG_BOOTSTRAP:-}" ]]; then')),
    worker.indexOf('fi\n\ninstall -D -m 0600', worker.indexOf('if [[ -n "${T3_CONFIG_BOOTSTRAP:-}" ]]; then')),
  );
  assert.match(legacyBlock, /config_source/);
  assert.match(legacyBlock, /rsync -rlpt --delete/);
  assert.match(worker, /if \[\[ -z "\$\{T3_CONFIG_BOOTSTRAP:-\}" && -f "\$OPENCODE_CONFIG_DIR\/package\.json" \]\]; then/);
  assert.match(worker, /npm install --prefix/);
});

test("issue worker installs generated files after bootstrap", () => {
  const workerMcp = worker.indexOf("provision-opencode-mcp.mjs");
  const workerBootstrap = worker.indexOf("run-config-bootstrap.sh issue-worker");
  const workerAgent = worker.indexOf("github-issue-worker-agent.md");
  const workerSandbox = worker.indexOf("t3-sandbox-only-plugin.js");
  assert.ok(workerBootstrap >= 0 && workerBootstrap < workerAgent);
  assert.ok(workerBootstrap < workerSandbox);
  assert.ok(workerBootstrap < workerMcp);
  assert.ok(workerBootstrap < worker.indexOf("github-issue-worker.mjs"));
});

function runWorkerFixture({ bootstrap }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-issue-worker-"));
  const optRoot = path.join(directory, "opt-t3-docker");
  const bin = path.join(directory, "bin");
  const configSource = path.join(directory, "config-source");
  const configDir = path.join(directory, "config");
  const dataRoot = path.join(directory, "data");
  const log = path.join(directory, "calls");
  fs.mkdirSync(optRoot, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(configSource, { recursive: true });
  fs.mkdirSync(path.join(configDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(configSource, "opencode.jsonc"), "{}\n");
  fs.writeFileSync(path.join(configSource, "package.json"), "{}\n");
  fs.writeFileSync(path.join(optRoot, "github-issue-worker-agent.md"), "agent\n");
  fs.writeFileSync(path.join(optRoot, "t3-sandbox-instructions.md"), "sandbox\n");
  fs.writeFileSync(path.join(optRoot, "t3-sandbox-only-plugin.js"), "plugin\n");
  fs.writeFileSync(path.join(optRoot, "github-issue-worker.mjs"), "worker\n");
  fs.writeFileSync(path.join(optRoot, "provision-opencode-mcp.mjs"), "provisioner\n");
  fs.writeFileSync(
    path.join(optRoot, "run-config-bootstrap.sh"),
    "#!/usr/bin/env bash\nprintf 'bootstrap:%s\\n' \"$1\" >> \"$T3_FIXTURE_LOG\"\nprintf '{}\\n' > \"$T3_FIXTURE_CONFIG/opencode.jsonc\"\nprintf '{}\\n' > \"$T3_FIXTURE_CONFIG/package.json\"\n",
  );
  fs.writeFileSync(path.join(bin, "rsync"), '#!/usr/bin/env bash\nprintf "rsync\\n" >> "$T3_FIXTURE_LOG"\nsrc="${@: -2:1}"\ndest="${@: -1}"\ncp -R "$src/." "$dest/"\n');
  fs.writeFileSync(path.join(bin, "npm"), '#!/usr/bin/env bash\nprintf "npm\\n" >> "$T3_FIXTURE_LOG"\n');
  fs.writeFileSync(path.join(bin, "node"), "#!/usr/bin/env bash\nexit 0\n");
  fs.writeFileSync(path.join(bin, "curl"), "#!/usr/bin/env bash\nexit 0\n");
  fs.writeFileSync(path.join(bin, "install"), '#!/usr/bin/env bash\nsrc="${@: -2:1}"\ndest="${@: -1}"\nmkdir -p "$(dirname "$dest")"\ncp "$src" "$dest"\n');
  for (const file of ["run-config-bootstrap.sh", "rsync", "npm", "node", "curl", "install"]) {
    fs.chmodSync(path.join(file === "run-config-bootstrap.sh" ? optRoot : bin, file), 0o755);
  }

  const fixtureEntrypoint = path.join(directory, "issue-worker-entrypoint.sh");
  fs.writeFileSync(
    fixtureEntrypoint,
    worker.replaceAll("/opt/t3-docker", optRoot),
  );
  fs.chmodSync(fixtureEntrypoint, 0o755);
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    T3_ISSUE_WORKER_DATA_ROOT: dataRoot,
    T3_ISSUE_WORKER_OPENCODE_CONFIG_SOURCE: bootstrap ? path.join(directory, "missing") : configSource,
    OPENCODE_CONFIG_DIR: configDir,
    T3_ISSUE_WORKER_GITHUB_TOKEN: "fixture-token",
    T3_ISSUE_WORKER_MODEL: "fixture-model",
    T3_SANDBOX_URL: "http://fixture",
    T3_SANDBOX_TOKEN: "fixture-sandbox-token",
    T3_FIXTURE_LOG: log,
    T3_FIXTURE_CONFIG: configDir,
    ...(bootstrap ? { T3_CONFIG_BOOTSTRAP: path.join(optRoot, "run-config-bootstrap.sh") } : { T3_CONFIG_BOOTSTRAP: "" }),
  };
  execFileSync("bash", [fixtureEntrypoint], { env: environment });
  return { configDir, log };
}

test("issue worker executes legacy sync and dependency installation when bootstrap is unset", () => {
  const { configDir, log } = runWorkerFixture({ bootstrap: false });
  assert.equal(fs.readFileSync(log, "utf8"), "rsync\nnpm\n");
  assert.equal(fs.readFileSync(path.join(configDir, "agents/github-issue-worker.md"), "utf8"), "agent\n");
  assert.equal(fs.readFileSync(path.join(configDir, "t3-sandbox-instructions.md"), "utf8"), "sandbox\n");
  assert.equal(fs.readFileSync(path.join(configDir, "plugins/t3-sandbox-only.js"), "utf8"), "plugin\n");
});

test("issue worker skips legacy sync and dependency installation during bootstrap", () => {
  const { configDir, log } = runWorkerFixture({ bootstrap: true });
  assert.equal(fs.readFileSync(log, "utf8"), "bootstrap:issue-worker\n");
  assert.equal(fs.readFileSync(path.join(configDir, "agents/github-issue-worker.md"), "utf8"), "agent\n");
  assert.equal(fs.readFileSync(path.join(configDir, "t3-sandbox-instructions.md"), "utf8"), "sandbox\n");
  assert.equal(fs.readFileSync(path.join(configDir, "plugins/t3-sandbox-only.js"), "utf8"), "plugin\n");
});


test("issue-worker passes supported provider keys without forwarding control credentials", () => {
  const source = fs.readFileSync(path.join(root, "scripts/github-issue-worker.mjs"), "utf8");
  const start = source.indexOf("function strippedEnvironment(");
  const end = source.indexOf("function gitEnvironment(", start);
  const providerKeys = ["LUMO_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY", "XAI_API_KEY"];
  const deniedKeys = ["GH_TOKEN", "GITHUB_TOKEN", "T3_ISSUE_WORKER_GITHUB_TOKEN", "ONYX_TOKEN", "SENTRY_AUTH_TOKEN"];
  const env = Object.fromEntries([...providerKeys, ...deniedKeys].map(key => [key, "fixture"]));
  const stripped = new Function("process", source.slice(start, end) + "; return strippedEnvironment;")({ env });
  const result = stripped();
  for (const key of providerKeys) assert.equal(result[key], "fixture", key);
  for (const key of deniedKeys) assert.equal(result[key], undefined, key);
});
