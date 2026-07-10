#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configPath =
  process.env.T3_CURSOR_MCP_CONFIG || path.join(os.homedir(), ".cursor", "mcp.json");
const reconcile = (process.env.T3_SANDBOX_MCP_RECONCILE || "1") === "1";
const desired = {};

if (process.env.T3_SANDBOX_URL && process.env.T3_SANDBOX_TOKEN) {
  desired["t3-sandbox"] = { command: "t3-sandbox-mcp", args: [] };
}
if (process.env.T3_XCODE_SSH_HOST && process.env.T3_XCODE_REMOTE_WORKSPACE_ROOT) {
  desired.xcodebuild = { command: "t3-xcode-mcp", args: [] };
}

let config = {};
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse existing Cursor MCP config ${configPath}: ${error.message}`);
  }
}
if (!config || typeof config !== "object" || Array.isArray(config)) {
  throw new Error(`Cursor MCP config ${configPath} must contain a JSON object`);
}
if (!config.mcpServers || typeof config.mcpServers !== "object") {
  config.mcpServers = {};
}

if (reconcile) {
  delete config.mcpServers["t3-sandbox"];
  delete config.mcpServers.xcodebuild;
}
Object.assign(config.mcpServers, desired);

if (!fs.existsSync(configPath) && Object.keys(config.mcpServers).length === 0) {
  process.exit(0);
}

fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
const temporary = `${configPath}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, configPath);
