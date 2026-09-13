import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provisioner = path.join(root, "scripts", "provision-generic-skills.py");
const skills = [
  "git-safety",
  "runtime-verification",
  "secret-risk",
  "lumo-capability-lift",
  "codex-escalation",
];

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(args, home, extra = {}, script = provisioner) {
  return spawnSync("python3", [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: home, ...extra },
  });
}

function signature(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      return entry.isFile()
        ? [path.relative(directory, full), sha256(full)]
        : [path.relative(directory, full), "directory"];
    })
    .sort(([left], [right]) => left.localeCompare(right));
}

test("generic assets have portable frontmatter and no harness-specific tool names", () => {
  for (const skill of skills) {
    const source = fs.readFileSync(path.join(root, "agent-assets", "skills", skill, "SKILL.md"), "utf8");
    const match = source.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(match, `${skill} YAML frontmatter`);
    assert.match(match[1], new RegExp(`^name: ${skill}$`, "m"));
    assert.doesNotMatch(source, /reviewer_plus|codex-escalate|editor-basic|implementer-plus/);
  }
});

test("user install is dry-run safe, transactional, idempotent, and uninstallable", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3-generic-user-"));
  const expected = skills.flatMap((skill) => [
    `.agents/skills/${skill}`,
    `.claude/skills/${skill}`,
  ]);
  const dryRun = run(["--scope", "user", "--dry-run"], fixture);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(fs.readdirSync(fixture).length, 0);
  assert.equal((dryRun.stdout.match(/^CHANGE:/gm) ?? []).length, expected.length);

  const first = run(["--scope", "user", "--install"], fixture);
  assert.equal(first.status, 0, first.stderr);
  for (const relative of expected) {
    const skill = path.basename(relative);
    const target = path.join(fixture, relative);
    const manifest = JSON.parse(fs.readFileSync(path.join(target, ".t3-docker-managed.json"), "utf8"));
    assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8").startsWith("---\n"), true);
    assert.equal(manifest.skill, skill);
    assert.deepEqual(manifest.files.map(({ path: file }) => file), ["SKILL.md"]);
    assert.equal(
      sha256(path.join(target, "SKILL.md")),
      sha256(path.join(root, "agent-assets", "skills", skill, "SKILL.md")),
      relative,
    );
  }

  const before = signature(fixture);
  const second = run(["--scope", "user", "--install"], fixture);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /No changes required/);
  assert.deepEqual(signature(fixture), before);

  const uninstall = run(["--scope", "user", "--uninstall"], fixture);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  for (const relative of expected) assert.equal(fs.existsSync(path.join(fixture, relative)), false);
});

test("a foreign target blocks every generic skill write", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3-generic-conflict-"));
  const foreign = path.join(fixture, ".claude", "skills", "secret-risk");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "SKILL.md"), "foreign\n");
  const result = run(["--scope", "user", "--install"], fixture);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /CONFLICT: Claude Code secret-risk/);
  assert.equal(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8"), "foreign\n");
  assert.equal(fs.existsSync(path.join(fixture, ".agents")), false);
});

test("container mode honors provider guards and the dedicated Claude home", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3-generic-container-"));
  const environment = {
    T3_CLAUDE_HOME_PATH: path.join(fixture, "claude-home"),
    T3_PROVIDER_CODEX: "1",
    T3_PROVIDER_OPENCODE: "1",
    T3_PROVIDER_CURSOR: "1",
    T3_PROVIDER_CLAUDE: "1",
  };
  const result = run(["--scope", "container"], fixture, environment);
  assert.equal(result.status, 0, result.stderr);
  for (const skill of skills) {
    assert.equal(fs.existsSync(path.join(fixture, ".agents", "skills", skill, "SKILL.md")), true);
    assert.equal(
      fs.existsSync(path.join(fixture, "claude-home", ".claude", "skills", skill, "SKILL.md")),
      true,
    );
  }

  const disabled = fs.mkdtempSync(path.join(os.tmpdir(), "t3-generic-disabled-"));
  const disabledResult = run(["--scope", "container"], disabled, {
    T3_PROVIDER_CODEX: "0",
    T3_PROVIDER_OPENCODE: "0",
    T3_PROVIDER_CURSOR: "0",
    T3_PROVIDER_CLAUDE: "0",
  });
  assert.equal(disabledResult.status, 0, disabledResult.stderr);
  assert.match(disabledResult.stdout, /No changes required/);
  assert.equal(fs.readdirSync(disabled).length, 0);
});

test("source discovery supports the flattened image layout", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3-generic-image-"));
  const imageRoot = path.join(fixture, "opt", "t3-docker");
  const imageScript = path.join(imageRoot, "provision-generic-skills.py");
  fs.mkdirSync(imageRoot, { recursive: true });
  fs.copyFileSync(provisioner, imageScript);
  fs.cpSync(path.join(root, "agent-assets"), path.join(imageRoot, "agent-assets"), { recursive: true });
  const result = run(["--scope", "user", "--dry-run"], path.join(fixture, "home"), {}, imageScript);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /image source is missing/);
});

test("container wiring provisions generic skills before harness startup", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const entrypoint = fs.readFileSync(path.join(root, "scripts", "entrypoint.sh"), "utf8");
  const worker = fs.readFileSync(path.join(root, "scripts", "issue-worker-entrypoint.sh"), "utf8");
  const agentRack = fs.readFileSync(path.join(root, "scripts", "provision-agent-rack.sh"), "utf8");
  assert.ok(dockerfile.includes("scripts/provision-generic-skills.py"));
  assert.ok(dockerfile.includes("/opt/t3-docker/provision-generic-skills.py"));
  const sync = entrypoint.indexOf("provision_provider_config_dirs");
  const generic = entrypoint.lastIndexOf("\nprovision_generic_skills\n");
  const start = entrypoint.indexOf("cleanup_stale_git_locks", generic);
  assert.ok(sync >= 0 && generic > sync && start > generic);
  const workerSync = worker.indexOf('"$config_source"/ "$OPENCODE_CONFIG_DIR"/');
  const workerGeneric = worker.indexOf("provision-generic-skills.py --scope container", workerSync);
  const workerStart = worker.indexOf("exec node /opt/t3-docker/github-issue-worker.mjs", workerGeneric);
  assert.ok(workerSync >= 0 && workerGeneric > workerSync && workerStart > workerGeneric);
  assert.match(agentRack, /agent-rack cp --target codex/);
  assert.match(agentRack, /shared_skill_root=/);
  assert.match(agentRack, /rsync -a --exclude='\.system\//);
});

test("argument combinations are strict", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3-generic-args-"));
  assert.notEqual(run(["--scope", "user"], fixture).status, 0);
  assert.notEqual(run(["--scope", "container", "--install"], fixture).status, 0);
  assert.notEqual(run(["--scope", "user", "--dry-run", "--install"], fixture).status, 0);
});
