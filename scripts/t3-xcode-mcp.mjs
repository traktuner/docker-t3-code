#!/usr/bin/env node
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import path from "node:path";

function required(name) {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function replacePath(value, from, to) {
  return typeof value === "string" ? value.split(from).join(to) : value;
}

function translate(value, from, to) {
  if (typeof value === "string") return replacePath(value, from, to);
  if (Array.isArray(value)) return value.map((item) => translate(item, from, to));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, translate(item, from, to)]),
    );
  }
  return value;
}

function relativeWorkspace(localRoot, cwd) {
  const relative = path.posix.relative(localRoot, cwd);
  if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new Error(`MCP cwd ${cwd} is outside T3_XCODE_LOCAL_WORKSPACE_ROOT ${localRoot}`);
  }
  return relative;
}

async function relayLines(input, output, from, to) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try {
      output.write(`${JSON.stringify(translate(JSON.parse(line), from, to))}\n`);
    } catch {
      output.write(`${replacePath(line, from, to)}\n`);
    }
  }
}

if (process.argv.includes("--self-test")) {
  const sample = { params: { path: "/workspace/repo/App.xcodeproj" } };
  const translated = translate(sample, "/workspace", "/Volumes/code");
  if (translated.params.path !== "/Volumes/code/repo/App.xcodeproj") process.exit(1);
  process.exit(0);
}

const host = required("T3_XCODE_SSH_HOST");
const localRoot = (process.env.T3_XCODE_LOCAL_WORKSPACE_ROOT || "/workspace").replace(/\/$/, "");
const remoteRoot = required("T3_XCODE_REMOTE_WORKSPACE_ROOT").replace(/\/$/, "");
const relative = relativeWorkspace(localRoot, process.cwd());
if (!relative) {
  throw new Error("Xcode MCP must run from a project below T3_XCODE_LOCAL_WORKSPACE_ROOT");
}
const workerCommand = `t3-xcode ${Buffer.from(relative).toString("base64url")}`;

const sshArgs = [
  "-T",
  "-p",
  process.env.T3_XCODE_SSH_PORT || "22",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "StrictHostKeyChecking=yes",
];

if ((process.env.T3_XCODE_SSH_IDENTITY_FILE || "").trim()) {
  sshArgs.push("-i", process.env.T3_XCODE_SSH_IDENTITY_FILE.trim());
}
if ((process.env.T3_XCODE_SSH_KNOWN_HOSTS || "").trim()) {
  sshArgs.push("-o", `UserKnownHostsFile=${process.env.T3_XCODE_SSH_KNOWN_HOSTS.trim()}`);
}
if ((process.env.T3_XCODE_SSH_OPTIONS_JSON || "").trim()) {
  const extra = JSON.parse(process.env.T3_XCODE_SSH_OPTIONS_JSON);
  if (!Array.isArray(extra) || !extra.every((item) => typeof item === "string")) {
    throw new Error("T3_XCODE_SSH_OPTIONS_JSON must be a JSON array of strings");
  }
  sshArgs.push(...extra);
}
sshArgs.push(host, workerCommand);

const child = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.pipe(process.stderr);

relayLines(process.stdin, child.stdin, localRoot, remoteRoot).catch((error) => {
  console.error(`Xcode MCP input relay failed: ${error.message}`);
  child.kill("SIGTERM");
});
const downstream = relayLines(child.stdout, process.stdout, remoteRoot, localRoot);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`Could not start Xcode MCP SSH bridge: ${error.message}`);
  process.exitCode = 1;
});

const [exitCode] = await Promise.all([
  new Promise((resolve) => child.on("close", resolve)),
  downstream,
]);
process.stdin.destroy();
process.exitCode = typeof exitCode === "number" ? exitCode : 1;
