#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: provision-agent-rack-config.mjs <config-path>");
  process.exit(2);
}

// Stock agent definitions from agent-rack's own default configuration.
// Only added when the key is absent; existing (unmanaged) agents are preserved.
const managedAgents = {
  claude: {
    name: "Claude Code CLI",
    command: "claude",
    args: ["--output-format", "json"],
    transport: "claude_stream_json",
    description: "Claude Code CLI streaming JSON agent",
    env: {},
  },
  opencode: {
    name: "OpenCode Interpreter",
    command: "opencode",
    args: ["run"],
    transport: "pty_interactive",
    description: "OpenCode interactive terminal CLI agent",
    env: {},
  },
  codex: {
    name: "Codex CLI",
    command: "codex",
    args: ["exec", "--json", "--skip-git-repo-check"],
    transport: "codex_exec_json",
    description: "OpenAI Codex CLI non-interactive JSON streaming agent",
    env: {},
  },
};

function positiveInteger(envName, fallback) {
  const raw = (process.env[envName] || "").trim();
  if (!raw) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${envName} must be a positive integer, got: ${raw}`);
  }
  return Number.parseInt(raw, 10);
}

function allowedWorkspaces() {
  const raw = (process.env.T3_AGENT_RACK_ALLOWED_WORKSPACES || "").trim();
  if (raw) {
    return raw.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [(process.env.T3_WORKDIR || "/workspace").trim() || "/workspace"];
}

function desiredConfig() {
  return {
    transport: "stdio",
    allowedWorkspaces: allowedWorkspaces(),
    security: {
      executionPolicy: "workspace-write",
      sanitizeEnv: true,
      maxConcurrentSessions: positiveInteger(
        "T3_AGENT_RACK_MAX_CONCURRENT_SESSIONS",
        6,
      ),
      defaultTimeoutSeconds: positiveInteger(
        "T3_AGENT_RACK_DEFAULT_TIMEOUT_SECONDS",
        43200,
      ),
      sessionRetentionMinutes: 2880,
      maxRetainedSessions: 200,
      maxSessionOutputBytes: 5000000,
    },
    enableSseSidecar: false,
  };
}

function loadExisting() {
  if (!fs.existsSync(configPath)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `${configPath} is not valid JSON and cannot be extended: ${error.message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object`);
  }
  return parsed;
}

const config = loadExisting();
const desired = desiredConfig();

for (const [key, value] of Object.entries(desired)) {
  if (key === "security") {
    const security = { ...(config.security || {}), ...value };
    config.security = security;
  } else {
    config[key] = value;
  }
}

config.agents = config.agents && typeof config.agents === "object" && !Array.isArray(config.agents)
  ? config.agents
  : {};
for (const [name, definition] of Object.entries(managedAgents)) {
  if (!config.agents[name]) config.agents[name] = definition;
}

const output = `${JSON.stringify(config, null, 2)}\n`;

if (!fs.existsSync(configPath) || fs.readFileSync(configPath, "utf8") !== output) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporary = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, output, { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  console.log(`Provisioned agent-rack configuration at ${configPath}`);
}
