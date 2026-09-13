import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provisioner = path.join(root, "scripts", "provision-harness-instructions.py");

test("reconciles native global harness rules without replacing user content", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-harness-policy-"));
  const policyPath = path.join(directory, "policy.md");
  const codexHome = path.join(directory, "codex");
  const claudeHome = path.join(directory, "claude");
  const grokHome = path.join(directory, "grok");
  const codexRules = path.join(codexHome, "AGENTS.md");
  const grokRulesTarget = path.join(directory, "shared-grok-rules.md");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(policyPath, "# Mandatory sandbox\n\nUse t3-sandbox first.\n");
  fs.writeFileSync(codexRules, "# Existing user rule\n");
  fs.writeFileSync(grokRulesTarget, "# Shared Grok rule\n");
  fs.symlinkSync(grokRulesTarget, path.join(grokHome, "AGENTS.md"));

  const environment = {
    ...process.env,
    CODEX_HOME: codexHome,
    T3_CLAUDE_HOME_PATH: claudeHome,
    GROK_CONFIG_DIR: grokHome,
    T3_HARNESS_SANDBOX_INSTRUCTIONS_FILE: policyPath,
    T3_HARNESS_SANDBOX_INSTRUCTIONS: "1",
    T3_SANDBOX_URL: "http://sandbox",
    T3_PROVIDER_CODEX: "1",
    T3_PROVIDER_CLAUDE: "1",
    T3_PROVIDER_GROK: "1",
  };

  execFileSync("python3", [provisioner], { env: environment });
  const once = fs.readFileSync(codexRules, "utf8");
  execFileSync("python3", [provisioner], { env: environment });
  const twice = fs.readFileSync(codexRules, "utf8");

  assert.equal(once, twice);
  assert.match(twice, /Existing user rule/);
  assert.equal((twice.match(/t3-docker:sandbox-policy:start/g) || []).length, 1);
  assert.match(
    fs.readFileSync(path.join(claudeHome, ".claude", "CLAUDE.md"), "utf8"),
    /Use t3-sandbox first/,
  );
  assert.match(fs.readFileSync(path.join(grokHome, "AGENTS.md"), "utf8"), /Use t3-sandbox first/);
  assert.equal(fs.lstatSync(path.join(grokHome, "AGENTS.md")).isSymbolicLink(), true);

  execFileSync("python3", [provisioner], {
    env: { ...environment, T3_HARNESS_SANDBOX_INSTRUCTIONS: "0" },
  });
  assert.equal(fs.readFileSync(codexRules, "utf8"), "# Existing user rule\n");
  assert.equal(fs.existsSync(path.join(claudeHome, ".claude", "CLAUDE.md")), false);
  assert.equal(fs.lstatSync(path.join(grokHome, "AGENTS.md")).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(grokRulesTarget, "utf8"), "# Shared Grok rule\n");
});

test("reconciles the shared Onyx rule into harness-native roots", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-onyx-policy-"));
  const onyxPolicyPath = path.join(directory, "onyx.md");
  const codexHome = path.join(directory, "codex");
  const claudeHome = path.join(directory, "claude");
  const grokHome = path.join(directory, "grok");
  const opencodeConfig = path.join(directory, "opencode");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(grokHome, { recursive: true });
  fs.mkdirSync(opencodeConfig, { recursive: true });
  fs.writeFileSync(onyxPolicyPath, "# Shared Onyx context\n\nUse Onyx first.\n");
  fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "# Existing Codex rule\n");
  fs.mkdirSync(path.join(claudeHome, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, ".claude", "CLAUDE.md"), "# Existing Claude rule\n");
  fs.writeFileSync(path.join(opencodeConfig, "AGENTS.md"), "# Existing OpenCode rule with Onyx\n");

  const environment = {
    ...process.env,
    CODEX_HOME: codexHome,
    T3_CLAUDE_HOME_PATH: claudeHome,
    GROK_CONFIG_DIR: grokHome,
    OPENCODE_CONFIG_DIR: opencodeConfig,
    T3_HARNESS_SANDBOX_INSTRUCTIONS_FILE: onyxPolicyPath,
    T3_HARNESS_SANDBOX_INSTRUCTIONS: "0",
    T3_HARNESS_ONYX_INSTRUCTIONS_FILE: onyxPolicyPath,
    T3_PROVIDER_CODEX: "1",
    T3_PROVIDER_CLAUDE: "1",
    T3_PROVIDER_GROK: "1",
    T3_PROVIDER_OPENCODE: "1",
  };

  execFileSync("python3", [provisioner], { env: environment });
  const codex = fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8");
  const claude = fs.readFileSync(path.join(claudeHome, ".claude", "CLAUDE.md"), "utf8");
  const grok = fs.readFileSync(path.join(grokHome, "AGENTS.md"), "utf8");
  const opencode = fs.readFileSync(path.join(opencodeConfig, "AGENTS.md"), "utf8");

  for (const content of [codex, claude, grok]) {
    assert.match(content, /Use Onyx first/);
    assert.equal((content.match(/t3-docker:onyx-policy:start/g) || []).length, 1);
  }
  assert.match(opencode, /Existing OpenCode rule with Onyx/);
  assert.doesNotMatch(opencode, /t3-docker:onyx-policy:start/);

  execFileSync("python3", [provisioner], { env: environment });
  assert.equal(fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8"), codex);
  assert.equal(fs.readFileSync(path.join(claudeHome, ".claude", "CLAUDE.md"), "utf8"), claude);
  assert.equal(fs.readFileSync(path.join(grokHome, "AGENTS.md"), "utf8"), grok);
});
