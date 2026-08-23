import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provisioner = path.join(root, "scripts", "provision-promo-video-skill.py");
const lockPath = path.join(root, "vendor", "promo-video-script", "LOCK.json");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const vendorRoot = path.join(root, "vendor", "promo-video-script", lock.commit);

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

test("vendor lock pins the complete upstream tree", () => {
  assert.equal(lock.repository, "https://github.com/Gnurpreet/promo-video-script-skill");
  assert.equal(lock.branch, "main");
  assert.equal(lock.commit, "0d34d65fb02b29016a25b38c3e1a593731732f76");
  assert.equal(lock.license, "MIT");
  assert.deepEqual(
    lock.files.map(({ path: relative }) => relative),
    ["LICENSE", "README.md", "SKILL.md"],
  );
  const actual = fs
    .readdirSync(vendorRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(vendorRoot, path.join(entry.parentPath, entry.name)))
    .sort();
  assert.deepEqual(actual, lock.files.map(({ path: relative }) => relative).sort());
  for (const entry of lock.files) {
    assert.equal(sha256(path.join(vendorRoot, entry.path)), entry.sha256, entry.path);
  }
});

test("skill frontmatter is portable and matches its directory", () => {
  const source = fs.readFileSync(path.join(vendorRoot, "SKILL.md"), "utf8");
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "YAML frontmatter");
  assert.match(match[1], /^name: promo-video-script$/m);
  assert.match(match[1], /^description: .+$/m);
  assert.match(source, /7–10 scene animated product promo video script/);
  assert.match(source, /Use `web_fetch` on the URL/);
});

test("user install is dry-run safe, idempotent, and uninstallable", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3-promo-user-"));
  const expected = [
    ".agents/skills/promo-video-script",
    ".claude/skills/promo-video-script",
    ".grok/skills/promo-video-script",
  ];
  const dryRun = run(["--scope", "user", "--dry-run"], fixture);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(fs.readdirSync(fixture).length, 0);
  assert.equal((dryRun.stdout.match(/^CHANGE:/gm) ?? []).length, 3);

  const first = run(["--scope", "user", "--install"], fixture);
  assert.equal(first.status, 0, first.stderr);
  for (const relative of expected) {
    assert.equal(fs.existsSync(path.join(fixture, relative, "SKILL.md")), true, relative);
    assert.equal(
      sha256(path.join(fixture, relative, "SKILL.md")),
      sha256(path.join(vendorRoot, "SKILL.md")),
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

test("a foreign skill blocks every planned write", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3-promo-conflict-"));
  const foreign = path.join(fixture, ".claude", "skills", "promo-video-script");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "SKILL.md"), "foreign\n");
  const result = run(["--scope", "user", "--install"], fixture);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /CONFLICT: Claude Code/);
  assert.equal(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8"), "foreign\n");
  assert.equal(fs.existsSync(path.join(fixture, ".agents")), false);
  assert.equal(fs.existsSync(path.join(fixture, ".grok")), false);
});

test("container mode installs every enabled harness path", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3-promo-container-"));
  const environment = {
    T3_CLAUDE_HOME_PATH: path.join(fixture, "claude-home"),
    GROK_CONFIG_DIR: path.join(fixture, "grok"),
    T3_PROVIDER_CODEX: "1",
    T3_PROVIDER_CLAUDE: "1",
    T3_PROVIDER_CURSOR: "1",
    T3_PROVIDER_OPENCODE: "1",
    T3_PROVIDER_GROK: "1",
  };
  const result = run(["--scope", "container"], fixture, environment);
  assert.equal(result.status, 0, result.stderr);
  for (const relative of [
    ".agents/skills/promo-video-script/SKILL.md",
    "claude-home/.claude/skills/promo-video-script/SKILL.md",
    "grok/skills/promo-video-script/SKILL.md",
  ]) assert.equal(fs.existsSync(path.join(fixture, relative)), true, relative);
});

test("source discovery supports the flattened image layout", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3-promo-image-"));
  const imageRoot = path.join(fixture, "opt", "t3-docker");
  const imageScript = path.join(imageRoot, "provision-promo-video-skill.py");
  fs.mkdirSync(imageRoot, { recursive: true });
  fs.copyFileSync(provisioner, imageScript);
  fs.cpSync(
    path.join(root, "vendor", "promo-video-script"),
    path.join(imageRoot, "vendor", "promo-video-script"),
    { recursive: true },
  );
  const result = run(["--scope", "user", "--dry-run"], path.join(fixture, "home"), {}, imageScript);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /image source is missing/);
});

test("container and issue-worker integration run before agent startup", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const entrypoint = fs.readFileSync(path.join(root, "scripts", "entrypoint.sh"), "utf8");
  const worker = fs.readFileSync(path.join(root, "scripts", "issue-worker-entrypoint.sh"), "utf8");
  for (const required of [
    "scripts/provision-promo-video-skill.py",
    "vendor/promo-video-script /opt/t3-docker/vendor/promo-video-script",
  ]) assert.ok(dockerfile.includes(required), required);
  const sync = entrypoint.indexOf("provision_provider_config_dirs");
  const promo = entrypoint.lastIndexOf("\nprovision_promo_video_skill\n");
  const update = entrypoint.indexOf("\nif [[ \"${T3_AUTO_UPDATE_EFFECTIVE", promo);
  assert.ok(sync >= 0 && promo > sync && update > promo);
  const workerSync = worker.indexOf('"$config_source"/ "$OPENCODE_CONFIG_DIR"/');
  const workerPromo = worker.indexOf("provision-promo-video-skill.py --scope container", workerSync);
  const workerStart = worker.indexOf("exec node /opt/t3-docker/github-issue-worker.mjs", workerPromo);
  assert.ok(workerSync >= 0 && workerPromo > workerSync && workerStart > workerPromo);
  assert.doesNotMatch(fs.readFileSync(provisioner, "utf8"), /https?:\/\//);
});

test("argument combinations are strict", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3-promo-args-"));
  assert.notEqual(run(["--scope", "user"], fixture).status, 0);
  assert.notEqual(run(["--scope", "container", "--install"], fixture).status, 0);
  assert.notEqual(run(["--scope", "user", "--dry-run", "--install"], fixture).status, 0);
});
