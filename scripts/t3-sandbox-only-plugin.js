import path from "node:path";

const blockedLocalTools = new Set([
  "apply_patch",
  "edit",
  "glob",
  "grep",
  "list",
  "multiedit",
  "patch",
  "read",
  "task",
  "write",
]);

class SandboxGatewayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const T3SandboxOnly = async ({ directory = "/workspace", worktree = "" } = {}) => {
  const baseUrl = (process.env.T3_SANDBOX_URL || "").replace(/\/$/, "");
  const token = process.env.T3_SANDBOX_TOKEN || "";
  const createTimeoutMs = positiveInteger(
    process.env.T3_SANDBOX_MCP_CREATE_TIMEOUT_MS,
    3_700_000,
  );
  const maxCommandSeconds = positiveInteger(
    process.env.T3_SANDBOX_MAX_COMMAND_SECONDS,
    1_800,
  );
  const sessionSandboxes = new Map();

  async function gateway(requestPath, options = {}, timeoutMs = 65_000) {
    if (!baseUrl || !token) {
      throw new Error("T3_SANDBOX_URL and T3_SANDBOX_TOKEN are required");
    }
    const response = await fetch(`${baseUrl}${requestPath}`, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });
    const raw = await response.text();
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { message: raw.slice(0, 2_000) };
      }
    }
    if (!response.ok) {
      const detail = body?.detail || body?.message || `HTTP ${response.status}`;
      throw new SandboxGatewayError(
        response.status,
        `Sandbox gateway rejected the request: ${detail}`,
      );
    }
    return body;
  }

  function sandboxForSession(sessionID, workspace) {
    const current = sessionSandboxes.get(sessionID);
    if (current?.workspace === workspace) return current.promise;

    const promise = gateway(
      "/v1/sandboxes",
      {
        method: "POST",
        body: JSON.stringify({ workspace, profile: "auto", reuse: true }),
      },
      createTimeoutMs,
    ).catch((error) => {
      sessionSandboxes.delete(sessionID);
      throw error;
    });
    sessionSandboxes.set(sessionID, { workspace, promise });
    return promise;
  }

  async function executeInSandbox(args, context, retry = true) {
    const workspace = context.worktree || context.directory || worktree || directory;
    const sandbox = await sandboxForSession(context.sessionID, workspace);
    const timeoutSeconds = Math.min(
      Math.max(1, Math.ceil((args.timeout || maxCommandSeconds * 1_000) / 1_000)),
      maxCommandSeconds,
    );
    const workingDirectory = args.workdir
      ? path.posix.isAbsolute(args.workdir)
        ? args.workdir
        : path.posix.join(workspace, args.workdir)
      : workspace;

    try {
      const result = await gateway(
        `/v1/sandboxes/${encodeURIComponent(sandbox.id)}/exec`,
        {
          method: "POST",
          body: JSON.stringify({
            command: args.command,
            working_directory: workingDirectory,
            timeout_seconds: timeoutSeconds,
          }),
        },
        timeoutSeconds * 1_000 + 30_000,
      );
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      return {
        title: `Sandbox shell (${result.exit_code ?? "unknown"})`,
        output: output || "Command completed without output.",
        metadata: {
          sandbox_id: sandbox.id,
          workspace,
          exit_code: result.exit_code,
        },
      };
    } catch (error) {
      if (retry && error instanceof SandboxGatewayError && [404, 409].includes(error.status)) {
        sessionSandboxes.delete(context.sessionID);
        return executeInSandbox(args, context, false);
      }
      throw error;
    }
  }

  return {
    tool: {
      bash: {
        description:
          "Run a shell command in the mandatory isolated T3 coding sandbox. " +
          "This tool never executes in the T3 control container; it automatically creates or " +
          "reuses the sandbox for this session. Use it for repository inspection, Git, edits, " +
          "builds, tests, package installation, and diagnostics.",
        args: {
          command: { type: "string", description: "The command to execute in the sandbox" },
        },
        execute: executeInSandbox,
      },
    },
    "tool.definition": async (input, output) => {
      if (!blockedLocalTools.has(input.toolID)) return;
      output.description =
        `Local tool '${input.toolID}' is unavailable in this deployment. ` +
        "Do not call it. Use the sandbox-backed bash tool or t3-sandbox MCP tools instead.";
    },
    "tool.execute.before": async (input) => {
      if (!blockedLocalTools.has(input.tool)) return;
      throw new Error(
        `Local tool '${input.tool}' is disabled. Do not retry it. Use the sandbox-backed bash ` +
          "tool or t3-sandbox MCP tools instead.",
      );
    },
  };
};
