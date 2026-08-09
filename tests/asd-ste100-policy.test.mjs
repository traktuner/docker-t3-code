import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provisioner = path.join(root, "scripts", "provision-ste100-policy.py");
const commit = "8564f8985f15104c2184f90531bfd1bbb25f3d5b";
const startMarker = "<!-- t3-docker:asd-ste100-policy:start -->";
const endMarker = "<!-- t3-docker:asd-ste100-policy:end -->";

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(args, home, extra = {}) {
  return spawnSync("python3", [provisioner, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, ...extra },
  });
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

test("vendor lock pins the exact upstream file set and hashes", () => {
  const lock = JSON.parse(read("vendor/asd-ste100/LOCK.json"));
  assert.equal(lock.repository, "https://github.com/danyuchn/asd-ste100-skill");
  assert.equal(lock.branch, "master");
  assert.equal(lock.commit, commit);
  assert.equal(lock.license, "MIT");
  const expected = [
    "LICENSE",
    "README.md",
    "SKILL.md",
    "examples/before-after.md",
    "references/writing-rules.md",
  ];
  assert.deepEqual(lock.files.map(({ path: file }) => file), expected);

  const vendorRoot = path.join(root, "vendor", "asd-ste100", commit);
  const actual = [];
  for (const directory of [vendorRoot, path.join(vendorRoot, "examples"), path.join(vendorRoot, "references")]) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile()) actual.push(path.relative(vendorRoot, path.join(directory, entry.name)));
    }
  }
  assert.deepEqual(actual.sort(), [...expected].sort());
  for (const entry of lock.files) {
    assert.equal(digest(path.join(vendorRoot, entry.path)), entry.sha256, entry.path);
    assert.equal(
      fs.readFileSync(path.join(vendorRoot, entry.path)).compare(
        fs.readFileSync(path.join(root, "agent-assets", "skills", "asd-ste100", "upstream", entry.path)),
      ),
      0,
      `overlay upstream copy changed: ${entry.path}`,
    );
  }
});

test("overlay skill has portable frontmatter and two explicit modes", () => {
  const skillPath = path.join(root, "agent-assets", "skills", "asd-ste100", "SKILL.md");
  const skill = fs.readFileSync(skillPath, "utf8");
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, "missing YAML frontmatter");
  const fields = Object.fromEntries(
    frontmatter[1].split("\n").map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }),
  );
  assert.equal(fields.name, "asd-ste100");
  assert.ok(fields.description);
  assert.match(skill, /Mode 1: silent writing mode/);
  assert.match(skill, /This mode is the default/);
  assert.match(skill, /Mode 2: explicit audit mode/);
  assert.match(skill, /only when the user explicitly requests/);
  for (const relative of [
    "upstream/LICENSE",
    "upstream/README.md",
    "upstream/references/writing-rules.md",
    "upstream/examples/before-after.md",
  ]) {
    assert.equal(fs.existsSync(path.join(path.dirname(skillPath), relative)), true, relative);
  }
});

test("user provisioner is conflict-safe, idempotent, and reversible", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-ste-user-"));
  const codexRules = path.join(home, ".codex", "AGENTS.md");
  const codexOverride = path.join(home, ".codex", "AGENTS.override.md");
  fs.mkdirSync(path.dirname(codexRules), { recursive: true });
  fs.writeFileSync(codexRules, "# User text without final newline");
  fs.writeFileSync(codexOverride, "# Existing override\n");

  const dry = run(["--scope", "user", "--dry-run"], home);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /CHANGE: install Codex policy/);
  assert.equal(fs.readFileSync(codexRules, "utf8"), "# User text without final newline");
  assert.equal(fs.existsSync(path.join(home, ".agents")), false);

  const install = run(["--scope", "user", "--install"], home);
  assert.equal(install.status, 0, install.stderr);
  const installed = fs.readFileSync(codexRules);
  assert.match(installed.toString("utf8"), /# User text without final newline/);
  assert.match(fs.readFileSync(codexOverride, "utf8"), /# Existing override/);
  assert.match(fs.readFileSync(codexOverride, "utf8"), /Mandatory ASD-STE100/);
  assert.equal((installed.toString("utf8").match(new RegExp(startMarker, "g")) || []).length, 1);
  assert.equal((installed.toString("utf8").match(new RegExp(endMarker, "g")) || []).length, 1);
  assert.equal(mode(codexRules), 0o644);
  for (const expected of [
    ".agents/skills/asd-ste100/SKILL.md",
    ".claude/skills/asd-ste100/SKILL.md",
    ".claude/CLAUDE.md",
    ".config/opencode/AGENTS.md",
  ]) {
    assert.equal(fs.existsSync(path.join(home, expected)), true, expected);
  }
  assert.equal(mode(path.join(home, ".claude", "CLAUDE.md")), 0o600);
  assert.equal(mode(path.join(home, ".config", "opencode", "AGENTS.md")), 0o600);

  const second = run(["--scope", "user", "--install"], home);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.trim(), "No changes required.");
  assert.equal(fs.readFileSync(codexRules).compare(installed), 0);
  const secondDry = run(["--scope", "user", "--dry-run"], home);
  assert.equal(secondDry.status, 0, secondDry.stderr);
  assert.equal(secondDry.stdout.trim(), "No changes required.");

  const uninstall = run(["--scope", "user", "--uninstall"], home);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(fs.readFileSync(codexRules, "utf8"), "# User text without final newline");
  assert.equal(fs.readFileSync(codexOverride, "utf8"), "# Existing override\n");
  assert.equal(fs.existsSync(path.join(home, ".agents", "skills", "asd-ste100")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "asd-ste100")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "CLAUDE.md")), false);
  assert.equal(fs.existsSync(path.join(home, ".config", "opencode", "AGENTS.md")), false);
});

test("preflight aborts before all changes for foreign skills or invalid markers", () => {
  const foreignHome = fs.mkdtempSync(path.join(os.tmpdir(), "t3-ste-foreign-"));
  const foreignSkill = path.join(foreignHome, ".agents", "skills", "asd-ste100");
  fs.mkdirSync(foreignSkill, { recursive: true });
  fs.writeFileSync(path.join(foreignSkill, "SKILL.md"), "foreign\n");
  const foreign = run(["--scope", "user", "--install"], foreignHome);
  assert.equal(foreign.status, 2);
  assert.match(foreign.stdout, /CONFLICT: Codex and OpenCode/);
  assert.equal(fs.existsSync(path.join(foreignHome, ".codex", "AGENTS.md")), false);

  const markerHome = fs.mkdtempSync(path.join(os.tmpdir(), "t3-ste-marker-"));
  const markerRules = path.join(markerHome, ".codex", "AGENTS.md");
  fs.mkdirSync(path.dirname(markerRules), { recursive: true });
  fs.writeFileSync(markerRules, `${startMarker}\nmissing end\n`);
  const marker = run(["--scope", "user", "--install"], markerHome);
  assert.equal(marker.status, 2);
  assert.match(marker.stdout, /incomplete or duplicate/);
  assert.equal(fs.readFileSync(markerRules, "utf8"), `${startMarker}\nmissing end\n`);
  assert.equal(fs.existsSync(path.join(markerHome, ".agents")), false);
});

test("preflight rejects duplicate markers and symlinks outside provider roots", () => {
  const duplicateHome = fs.mkdtempSync(path.join(os.tmpdir(), "t3-ste-duplicate-"));
  const duplicateRules = path.join(duplicateHome, ".codex", "AGENTS.md");
  fs.mkdirSync(path.dirname(duplicateRules), { recursive: true });
  fs.writeFileSync(
    duplicateRules,
    `${startMarker}\n${endMarker}\n${startMarker}\n${endMarker}\n`,
  );
  const duplicate = run(["--scope", "user", "--dry-run"], duplicateHome);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stdout, /incomplete or duplicate/);

  const symlinkHome = fs.mkdtempSync(path.join(os.tmpdir(), "t3-ste-symlink-"));
  const outside = path.join(os.tmpdir(), `t3-ste-outside-${crypto.randomUUID()}.md`);
  fs.writeFileSync(outside, "outside user text\n");
  fs.mkdirSync(path.join(symlinkHome, ".codex"), { recursive: true });
  fs.symlinkSync(outside, path.join(symlinkHome, ".codex", "AGENTS.md"));
  const symlink = run(["--scope", "user", "--install"], symlinkHome);
  assert.equal(symlink.status, 2);
  assert.match(symlink.stdout, /symlink target escapes/);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside user text\n");
  assert.equal(fs.existsSync(path.join(symlinkHome, ".agents")), false);
  fs.unlinkSync(outside);
});

test("uninstall rejects unexpected nested managed-manifest names", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-ste-nested-manifest-"));
  const install = run(["--scope", "user", "--install"], home);
  assert.equal(install.status, 0, install.stderr);
  const skill = path.join(home, ".agents", "skills", "asd-ste100");
  const nested = path.join(skill, "private", ".t3-docker-managed.json");
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, "unrelated user data\n");

  const uninstall = run(["--scope", "user", "--uninstall"], home);
  assert.equal(uninstall.status, 2);
  assert.match(uninstall.stdout, /missing or unexpected files/);
  assert.equal(fs.readFileSync(nested, "utf8"), "unrelated user data\n");
  assert.equal(fs.existsSync(skill), true);
});

test("uninstall rejects unexpected empty directories in a managed skill", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-ste-empty-directory-"));
  const install = run(["--scope", "user", "--install"], home);
  assert.equal(install.status, 0, install.stderr);
  const skill = path.join(home, ".agents", "skills", "asd-ste100");
  const unexpected = path.join(skill, "private-empty");
  fs.mkdirSync(unexpected);

  const uninstall = run(["--scope", "user", "--uninstall"], home);
  assert.equal(uninstall.status, 2);
  assert.match(uninstall.stdout, /unexpected directories/);
  assert.equal(fs.existsSync(unexpected), true);
  assert.equal(fs.existsSync(skill), true);
});

test("a late write failure rolls back earlier targets and new parent directories", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-ste-rollback-"));
  const claudeRoot = path.join(home, ".claude");
  fs.mkdirSync(claudeRoot, { recursive: true, mode: 0o500 });
  fs.chmodSync(claudeRoot, 0o500);
  try {
    const result = run(["--scope", "user", "--install"], home);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /installation transaction failed/);
    assert.equal(fs.existsSync(path.join(home, ".codex", "AGENTS.md")), false);
    assert.equal(fs.existsSync(path.join(home, ".codex")), false);
    assert.equal(fs.existsSync(path.join(home, ".agents")), false);
  } finally {
    fs.chmodSync(claudeRoot, 0o700);
  }
});

test("container scope installs every enabled provider without a sandbox URL", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-ste-container-"));
  const environment = {
    CODEX_HOME: path.join(home, "codex"),
    T3_CLAUDE_HOME_PATH: path.join(home, "claude-home"),
    OPENCODE_CONFIG_DIR: path.join(home, "opencode"),
    GROK_CONFIG_DIR: path.join(home, "grok"),
    T3_PROVIDER_CODEX: "1",
    T3_PROVIDER_CLAUDE: "1",
    T3_PROVIDER_OPENCODE: "1",
    T3_PROVIDER_GROK: "1",
    T3_SANDBOX_URL: "",
  };
  const result = run(["--scope", "container"], home, environment);
  assert.equal(result.status, 0, result.stderr);
  for (const expected of [
    "codex/AGENTS.md",
    "claude-home/.claude/CLAUDE.md",
    "opencode/AGENTS.md",
    "grok/AGENTS.md",
    ".agents/skills/asd-ste100/SKILL.md",
    "claude-home/.claude/skills/asd-ste100/SKILL.md",
  ]) {
    assert.equal(fs.existsSync(path.join(home, expected)), true, expected);
  }
});

test("container integration orders provisioning after sync and before harness start", () => {
  const dockerfile = read("Dockerfile");
  const entrypoint = read("scripts/entrypoint.sh");
  const worker = read("scripts/issue-worker-entrypoint.sh");
  const provisionerSource = read("scripts/provision-ste100-policy.py");
  for (const required of [
    "scripts/provision-ste100-policy.py",
    "agent-assets /opt/t3-docker/agent-assets",
    "vendor/asd-ste100 /opt/t3-docker/vendor/asd-ste100",
  ]) assert.ok(dockerfile.includes(required), required);
  const runtime = entrypoint.indexOf("hydrate_github_auth_for_opencode\nprovision_provider_config_dirs");
  const ste = entrypoint.indexOf("\nprovision_ste100_policy\n", runtime);
  const openCode = entrypoint.indexOf("\nstart_managed_opencode_server\n", runtime);
  assert.ok(runtime >= 0 && ste > runtime && openCode > ste);
  const sync = worker.indexOf('"$config_source"/ "$OPENCODE_CONFIG_DIR"/');
  const workerSte = worker.indexOf("provision-ste100-policy.py --scope container", sync);
  const workerStart = worker.indexOf("exec node /opt/t3-docker/github-issue-worker.mjs", workerSte);
  assert.ok(sync >= 0 && workerSte > sync && workerStart > workerSte);
  assert.match(worker, /T3_OPENCODE_SANDBOX_ONLY/);
  assert.doesNotMatch(provisionerSource, /https?:\/\//);
});

test("language smoke contract covers every required case", () => {
  const fixtures = JSON.parse(read("tests/fixtures/asd-ste100-language-smokes.json"));
  assert.deepEqual(fixtures.map(({ id }) => id), [
    "long-tool-description",
    "ambiguous-error-message",
    "subagent-brief",
    "conditional-status-report",
    "safety-critical-instruction",
    "code-log-quote",
    "german-text",
    "explicit-ste-audit",
  ]);
  assert.equal(fixtures.filter(({ mode }) => mode === "audit").length, 1);
  assert.equal(fixtures.find(({ id }) => id === "german-text").language, "de");
  assert.ok(fixtures.filter(({ mustPreserve }) => mustPreserve).every(({ mustPreserve }) => mustPreserve.length > 0));
});

test("argument combinations are strict", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-ste-args-"));
  assert.notEqual(run(["--scope", "user"], home).status, 0);
  assert.notEqual(run(["--scope", "container", "--install"], home).status, 0);
  assert.notEqual(run(["--scope", "user", "--dry-run", "--install"], home).status, 0);
});
