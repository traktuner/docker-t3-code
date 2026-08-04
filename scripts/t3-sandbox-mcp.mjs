#!/usr/bin/env node
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = (
  process.env.T3_SANDBOX_URL || "http://t3-sandbox-gateway:8090"
).replace(/\/$/, "");
const tokenFile =
  process.env.T3_SANDBOX_TOKEN_FILE ||
  "/run/t3-sandbox-secrets/gateway-token";
let token = process.env.T3_SANDBOX_TOKEN || "";
if (!token && tokenFile) {
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    // The common validation below reports the missing credential uniformly.
  }
}
const defaultWorkspace = process.env.T3_SANDBOX_WORKSPACE || process.cwd();
const lockWorkspace = /^(?:1|true|yes|on)$/i.test(
  process.env.T3_SANDBOX_LOCK_WORKSPACE || "",
);
const lockedWorkspace = path.resolve(defaultWorkspace);
const ownedSandboxes = new Set();

function requestGateway(url, options, signal) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      {
        method: options.method || "GET",
        headers: options.headers,
        signal,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            ok:
              response.statusCode !== undefined &&
              response.statusCode >= 200 &&
              response.statusCode < 300,
            status: response.statusCode,
            text: () => Promise.resolve(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      },
    );
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

if (!baseUrl || !token) {
  console.error("T3_SANDBOX_URL and T3_SANDBOX_TOKEN are required");
  process.exit(2);
}

function workspaceForRequest(workspace) {
  const requested = workspace || defaultWorkspace;
  if (!lockWorkspace) return requested;
  if (path.resolve(requested) !== lockedWorkspace) {
    throw new Error(
      "This MCP session is restricted to its configured workspace",
    );
  }
  return lockedWorkspace;
}

function requireOwnedSandbox(sandboxId) {
  if (lockWorkspace && !ownedSandboxes.has(sandboxId)) {
    throw new Error("This MCP session can use only sandboxes it created");
  }
}

async function gateway(
  path,
  options = {},
  timeoutMs = 65_000,
  externalSignal = null,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await requestGateway(new URL(`${baseUrl}${path}`), {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    }, externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal);
    const raw = await response.text();
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { message: raw.slice(0, 2000) };
      }
    }
    if (!response.ok) {
      const detail = body?.detail || body?.message || `HTTP ${response.status}`;
      throw new Error(`Sandbox gateway rejected the request: ${detail}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function withProgress(extra, message, operation) {
  let progress = 0;
  let sending = false;
  const send = async () => {
    if (sending || extra._meta?.progressToken === undefined) return;
    sending = true;
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: extra._meta.progressToken,
          progress: ++progress,
          message,
        },
      });
    } finally {
      sending = false;
    }
  };
  await send();
  const interval = setInterval(() => void send(), 10_000);
  try {
    return await operation();
  } finally {
    clearInterval(interval);
  }
}

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent:
      value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined,
  };
}

function failure(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

const server = new McpServer({
  name: "t3-sandbox",
  version: "0.1.0",
});

server.registerTool(
  "sandbox_create",
  {
    title: "Create coding sandbox",
    description:
      "Create or reuse an isolated coding environment for the current T3 worktree. " +
      "Use it before build-, test-, package-, or media-heavy work; the base includes compilers, " +
      "debuggers, FFmpeg, ImageMagick, OCR, PDF, image, and audio tools. Use profile=auto to " +
      "honor a safe devcontainer.json when present. Workspace edits and build caches persist, " +
      "but model/provider credentials are intentionally absent.",
    inputSchema: {
      workspace: z
        .string()
        .optional()
        .describe("T3 worktree path; defaults to the MCP process cwd"),
      profile: z.enum(["auto", "base", "devcontainer"]).default("auto"),
      ttl_seconds: z.number().int().min(60).optional(),
      reuse: z.boolean().default(true),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ workspace, profile, ttl_seconds, reuse }, extra) => {
    try {
      const selectedWorkspace = workspaceForRequest(workspace);
      const created = await withProgress(
        extra,
        "Preparing coding sandbox",
        () =>
          gateway(
            "/v1/sandboxes",
            {
              method: "POST",
              body: JSON.stringify({
                workspace: selectedWorkspace,
                profile,
                ttl_seconds,
                reuse,
              }),
            },
            Number(process.env.T3_SANDBOX_MCP_CREATE_TIMEOUT_MS || 3_700_000),
            extra.signal,
          ),
      );
      if (lockWorkspace && typeof created?.id === "string")
        ownedSandboxes.add(created.id);
      return result(created);
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "sandbox_exec",
  {
    title: "Run command in coding sandbox",
    description:
      "Run a shell command in an active sandbox. Output is returned only after completion; " +
      "use targeted commands and explicit timeouts for long builds.",
    inputSchema: {
      sandbox_id: z.string().uuid(),
      command: z.string().min(1),
      working_directory: z.string().default("/workspace"),
      timeout_seconds: z.number().int().min(1).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (
    { sandbox_id, command, working_directory, timeout_seconds },
    extra,
  ) => {
    try {
      requireOwnedSandbox(sandbox_id);
      const timeoutMs = (timeout_seconds || 1800) * 1000 + 30_000;
      return result(
        await withProgress(
          extra,
          "Command is still running in the coding sandbox",
          () =>
            gateway(
              `/v1/sandboxes/${encodeURIComponent(sandbox_id)}/exec`,
              {
                method: "POST",
                body: JSON.stringify({
                  command,
                  working_directory,
                  timeout_seconds,
                }),
              },
              timeoutMs,
              extra.signal,
            ),
        ),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "sandbox_status",
  {
    title: "Get coding sandbox status",
    description:
      "Return the current state and expiration of one coding sandbox.",
    inputSchema: { sandbox_id: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ sandbox_id }) => {
    try {
      requireOwnedSandbox(sandbox_id);
      return result(
        await gateway(`/v1/sandboxes/${encodeURIComponent(sandbox_id)}`),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "sandbox_list",
  {
    title: "List coding sandboxes",
    description: "List recent coding sandboxes and their lease states.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const sandboxes = await gateway("/v1/sandboxes");
      return result(
        lockWorkspace && Array.isArray(sandboxes)
          ? sandboxes.filter((sandbox) => ownedSandboxes.has(sandbox?.id))
          : sandboxes,
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "sandbox_renew",
  {
    title: "Renew coding sandbox",
    description: "Reset an active sandbox lease to the requested lifetime.",
    inputSchema: {
      sandbox_id: z.string().uuid(),
      ttl_seconds: z.number().int().min(60),
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ sandbox_id, ttl_seconds }) => {
    try {
      requireOwnedSandbox(sandbox_id);
      return result(
        await gateway(`/v1/sandboxes/${encodeURIComponent(sandbox_id)}/renew`, {
          method: "POST",
          body: JSON.stringify({ ttl_seconds }),
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "sandbox_destroy",
  {
    title: "Destroy coding sandbox",
    description:
      "Immediately terminate a coding sandbox and release its workspace lease.",
    inputSchema: { sandbox_id: z.string().uuid() },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ sandbox_id }) => {
    try {
      requireOwnedSandbox(sandbox_id);
      await gateway(`/v1/sandboxes/${encodeURIComponent(sandbox_id)}`, {
        method: "DELETE",
      });
      ownedSandboxes.delete(sandbox_id);
      return result({ sandbox_id, state: "destroyed" });
    } catch (error) {
      return failure(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
