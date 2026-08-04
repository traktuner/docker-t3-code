#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const endpoint = new URL(
  process.env.T3_GITHUB_MCP_URL || "https://api.githubcopilot.com/mcp/",
);

function githubToken() {
  for (const name of ["GITHUB_PERSONAL_ACCESS_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = (process.env[name] || "").trim();
    if (value) return value;
  }

  const hostname = process.env.GH_HOST || process.env.GITHUB_HOST || "github.com";
  try {
    return execFileSync("gh", ["auth", "token", "--hostname", hostname], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const token = githubToken();
if (!token) {
  console.error(
    "GitHub MCP requires a persisted t3-auth gh login or a GitHub token environment variable",
  );
  process.exit(2);
}

const remote = new Client({ name: "t3-github-mcp-proxy", version: "0.1.0" });
const remoteTransport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: {
    headers: { Authorization: `Bearer ${token}` },
  },
});
await remote.connect(remoteTransport);

const server = new Server(
  { name: "github", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Use these tools for GitHub reads and authorized mutations. Repository shell commands remain in t3-sandbox.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async (request) =>
  remote.listTools(request.params),
);
server.setRequestHandler(CallToolRequestSchema, async (request) =>
  remote.callTool(request.params),
);

const close = async () => {
  await remote.close().catch(() => {});
};
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("exit", () => void remoteTransport.close().catch(() => {}));

await server.connect(new StdioServerTransport());
