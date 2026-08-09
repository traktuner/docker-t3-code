#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pathToFileURL } from "node:url";

function truthy(value) {
  return /^(?:1|true|yes|on)$/i.test((value || "").trim());
}

export function injectPolicyLine(line, policy, injectedSessions) {
  if (!policy || !line.trim()) return line;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }

  if (message?.method !== "session/prompt" || !Array.isArray(message?.params?.prompt)) {
    return line;
  }

  const sessionId = String(message.params.sessionId || "");
  if (!sessionId || injectedSessions.has(sessionId)) return line;

  message.params.prompt.unshift({
    type: "text",
    text: `<managed_system_policy>\n${policy.trim()}\n</managed_system_policy>`,
  });
  injectedSessions.add(sessionId);
  return JSON.stringify(message);
}

export function combinePolicies(stePolicy, sandboxPolicy) {
  return [stePolicy, sandboxPolicy]
    .map((policy) => (policy || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

class JsonLinePolicyTransform extends Transform {
  constructor(policy) {
    super();
    this.buffer = "";
    this.policy = policy;
    this.injectedSessions = new Set();
  }

  _transform(chunk, _encoding, callback) {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      this.push(`${injectPolicyLine(normalized, this.policy, this.injectedSessions)}\n`);
    }
    callback();
  }

  _flush(callback) {
    if (this.buffer) {
      this.push(injectPolicyLine(this.buffer, this.policy, this.injectedSessions));
    }
    callback();
  }
}

export function readPolicy(environment) {
  const stePolicyPath =
    environment.T3_STE100_POLICY_FILE ||
    "/opt/t3-docker/agent-assets/policies/asd-ste100-mandatory.md";
  const stePolicy = fs.readFileSync(stePolicyPath, "utf8");
  const sandboxActive =
    Boolean((environment.T3_SANDBOX_URL || "").trim()) &&
    truthy(
      environment.T3_HARNESS_SANDBOX_INSTRUCTIONS ??
        environment.T3_OPENCODE_SANDBOX_INSTRUCTIONS ??
        "1",
    );
  let sandboxPolicy = "";
  if (sandboxActive) {
    const sandboxPolicyPath =
      environment.T3_HARNESS_SANDBOX_INSTRUCTIONS_FILE ||
      "/opt/t3-docker/t3-sandbox-instructions.md";
    sandboxPolicy = fs.readFileSync(sandboxPolicyPath, "utf8");
  }
  return combinePolicies(stePolicy, sandboxPolicy);
}

function run() {
  const args = process.argv.slice(2);
  const realBinary = process.env.T3_CURSOR_REAL_BINARY_PATH || "agent";
  const isAcp = args.includes("acp");
  const child = spawn(realBinary, args, {
    env: process.env,
    stdio: isAcp ? ["pipe", "inherit", "inherit"] : "inherit",
  });

  child.on("error", (error) => {
    console.error(`Failed to start Cursor Agent at ${realBinary}: ${error.message}`);
    process.exitCode = 127;
  });

  if (isAcp) {
    process.stdin.pipe(new JsonLinePolicyTransform(readPolicy(process.env))).pipe(child.stdin);
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    const signalExitCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
    process.exit(code ?? signalExitCode);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
