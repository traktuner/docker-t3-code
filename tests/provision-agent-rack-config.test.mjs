import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provisioner = path.join(root, "scripts", "provision-agent-rack-config.mjs");

const baseEnv = {
  ...process.env,
  T3_AGENT_RACK_ALLOWED_WORKSPACES: "",
  T3_WORKDIR: "",
  T3_AGENT_RACK_MAX_CONCURRENT_SESSIONS: "",
  T3_AGENT_RACK_DEFAULT_TIMEOUT_SECONDS: "",
};

function runProvisioner(config, env = baseEnv) {
  execFileSync("node", [provisioner, config], { env });
}

test("creates a default configuration in an empty directory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-agent-rack-default-"));
  const config = path.join(directory, "agent-rack", "config.json");

  runProvisioner(config);

  const parsed = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.equal(parsed.transport, "stdio");
  assert.deepEqual(parsed.allowedWorkspaces, ["/workspace"]);
  assert.equal(parsed.security.executionPolicy, "workspace-write");
  assert.equal(parsed.security.sanitizeEnv, true);
  assert.equal(parsed.security.maxConcurrentSessions, 6);
  assert.equal(parsed.security.defaultTimeoutSeconds, 43200);
  assert.equal(parsed.security.sessionRetentionMinutes, 2880);
  assert.equal(parsed.security.maxRetainedSessions, 200);
  assert.equal(parsed.security.maxSessionOutputBytes, 5000000);
  assert.equal(parsed.enableSseSidecar, false);
  assert.deepEqual(Object.keys(parsed.agents).sort(), ["claude", "codex", "opencode"]);
  assert.deepEqual(parsed.agents.codex.args, ["exec", "--json", "--skip-git-repo-check"]);
  const stats = fs.statSync(config);
  assert.equal(stats.mode & 0o777, 0o600);
});

test("running twice produces an identical file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-agent-rack-idempotent-"));
  const config = path.join(directory, "config.json");

  runProvisioner(config);
  const once = fs.readFileSync(config, "utf8");
  runProvisioner(config);
  const twice = fs.readFileSync(config, "utf8");

  assert.equal(once, twice);
});

test("applies environment overrides", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-agent-rack-env-"));
  const config = path.join(directory, "config.json");

  runProvisioner(config, {
    ...baseEnv,
    T3_AGENT_RACK_ALLOWED_WORKSPACES: "/workspace,/data/projects",
    T3_AGENT_RACK_MAX_CONCURRENT_SESSIONS: "3",
    T3_AGENT_RACK_DEFAULT_TIMEOUT_SECONDS: "600",
  });

  const parsed = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.deepEqual(parsed.allowedWorkspaces, ["/workspace", "/data/projects"]);
  assert.equal(parsed.security.maxConcurrentSessions, 3);
  assert.equal(parsed.security.defaultTimeoutSeconds, 600);
});

test("uses T3_WORKDIR as the default allowed workspace", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-agent-rack-workdir-"));
  const config = path.join(directory, "config.json");

  runProvisioner(config, { ...baseEnv, T3_WORKDIR: "/projects/demo" });

  const parsed = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.deepEqual(parsed.allowedWorkspaces, ["/projects/demo"]);
});

test("preserves unmanaged agents and security keys on an existing config", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-agent-rack-extend-"));
  const config = path.join(directory, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      transport: "stdio",
      allowedWorkspaces: ["/custom"],
      agents: {
        "custom-agent": { name: "Custom", command: "/usr/bin/custom" },
        codex: { name: "Overridden Codex", command: "codex" },
      },
      security: {
        executionPolicy: "read-only",
        maxSessionOutputBytes: 42,
      },
    }),
  );

  runProvisioner(config);

  const parsed = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.deepEqual(parsed.agents["custom-agent"], {
    name: "Custom",
    command: "/usr/bin/custom",
  });
  assert.equal(parsed.agents.codex.name, "Overridden Codex");
  // allowedWorkspaces and the security block are fully managed (derived from
  // the environment and container policy), while agents are additive.
  assert.deepEqual(parsed.allowedWorkspaces, ["/workspace"]);
  assert.equal(parsed.security.executionPolicy, "workspace-write");
  assert.equal(parsed.security.maxSessionOutputBytes, 5000000);
  // Managed security keys are still applied around preserved ones.
  assert.equal(parsed.security.sanitizeEnv, true);
  assert.equal(parsed.security.defaultTimeoutSeconds, 43200);
});

test("rejects an invalid existing config instead of overwriting it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-agent-rack-invalid-"));
  const config = path.join(directory, "config.json");
  fs.writeFileSync(config, "not json at all");

  assert.throws(() => runProvisioner(config));
  assert.equal(fs.readFileSync(config, "utf8"), "not json at all");
});

test("rejects a non-positive-integer override", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-agent-rack-badenv-"));
  const config = path.join(directory, "config.json");

  assert.throws(() =>
    runProvisioner(config, { ...baseEnv, T3_AGENT_RACK_MAX_CONCURRENT_SESSIONS: "zero" }),
  );
});
