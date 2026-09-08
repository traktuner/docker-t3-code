#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const workspaceRoot = process.env.T3_GITHUB_MCP_WORKSPACE_ROOT || process.env.T3_WORKDIR || "/workspace";
const githubHost = (process.env.GH_HOST || "github.com").trim();
const maxOutputBytes = 1_000_000;

if (!/^[A-Za-z0-9.-]+$/.test(githubHost)) {
  throw new Error("GH_HOST must contain only a hostname");
}

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function failure(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

function boundedCollector() {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    append(chunk) {
      if (bytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - bytes;
      const selected = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(selected);
      bytes += selected.length;
      if (selected.length !== chunk.length) truncated = true;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    get truncated() {
      return truncated;
    },
  };
}

function run(command, args, { cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = boundedCollector();
    const stderr = boundedCollector();
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.once("close", (exitCode, terminationSignal) =>
      finish({
        exit_code: exitCode ?? 1,
        signal: terminationSignal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        output_truncated: stdout.truncated || stderr.truncated,
      }),
    );
  });
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function repositoryContext(signal) {
  const currentDirectory = realpathSync(process.cwd());
  const allowedRoot = realpathSync(workspaceRoot);
  if (!isInside(currentDirectory, allowedRoot)) {
    throw new Error(`GitHub control tools are limited to ${allowedRoot}`);
  }
  const topLevel = await run("git", ["rev-parse", "--show-toplevel"], {
    cwd: currentDirectory,
    signal,
  });
  if (topLevel.exit_code !== 0) throw new Error("The active directory is not a Git repository");
  const repositoryRoot = realpathSync(topLevel.stdout.trim());
  if (!isInside(repositoryRoot, allowedRoot)) {
    throw new Error(`The Git repository must be below ${allowedRoot}`);
  }
  const origin = await run("git", ["remote", "get-url", "origin"], {
    cwd: repositoryRoot,
    signal,
  });
  if (origin.exit_code !== 0) throw new Error("The active Git repository has no origin remote");
  const repository = githubRepository(origin.stdout.trim());
  if (!repository) {
    throw new Error(`origin is not a ${githubHost} owner/repository URL`);
  }
  return { repositoryRoot, repository };
}

function githubRepository(origin) {
  const escapedHost = githubHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = origin.match(
    new RegExp(`^(?:https?://${escapedHost}/|git@${escapedHost}:)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\\.git)?/?$`),
  );
  return match ? `${match[1]}/${match[2]}` : "";
}

const server = new McpServer({ name: "t3-github", version: "0.1.0" });

server.registerTool(
  "github_auth_status",
  {
    title: "Check GitHub control-plane authentication",
    description:
      "Check the control-container GitHub CLI login without returning a token. This is the only supported way to diagnose GitHub authentication from an isolated task.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (_input, extra) => {
    try {
      return result({ host: githubHost, ...(await run("gh", ["auth", "status", "--hostname", githubHost], { signal: extra.signal })) });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "github_actions_list",
  {
    title: "List GitHub Actions runs for the active repository",
    description: "List recent GitHub Actions runs for the active workspace repository.",
    inputSchema: {
      limit: z.number().int().min(1).max(30).default(10),
      branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,250}$/).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ limit, branch }, extra) => {
    try {
      const { repository } = await repositoryContext(extra.signal);
      const args = [
        "run", "list", "--repo", repository, "--limit", String(limit),
        "--json", "databaseId,status,conclusion,workflowName,displayTitle,headBranch,headSha,url",
      ];
      if (branch) args.push("--branch", branch);
      return result({ repository, ...(await run("gh", args, { signal: extra.signal })) });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "github_actions_watch",
  {
    title: "Watch one GitHub Actions run",
    description:
      "Wait for one GitHub Actions run in the active workspace repository. A failed run is returned with its non-zero exit code and is not treated as an MCP transport failure.",
    inputSchema: {
      run_id: z.string().regex(/^\d+$/),
      interval_seconds: z.number().int().min(3).max(60).default(5),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ run_id, interval_seconds }, extra) => {
    try {
      const { repository } = await repositoryContext(extra.signal);
      return result({
        repository,
        run_id,
        ...(await run(
          "gh",
          ["run", "watch", run_id, "--repo", repository, "--compact", "--exit-status", "--interval", String(interval_seconds)],
          { signal: extra.signal },
        )),
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "github_actions_failed_log",
  {
    title: "Read failed GitHub Actions log output",
    description: "Return failed-step log output for one GitHub Actions run in the active workspace repository.",
    inputSchema: { run_id: z.string().regex(/^\d+$/) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ run_id }, extra) => {
    try {
      const { repository } = await repositoryContext(extra.signal);
      return result({
        repository,
        run_id,
        ...(await run("gh", ["run", "view", run_id, "--repo", repository, "--log-failed"], { signal: extra.signal })),
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "github_push_current_branch",
  {
    title: "Push the current branch through the GitHub control plane",
    description:
      "Push only the active branch of the active workspace repository to origin. Call this only after the user explicitly authorizes a push. Force-pushes, branch deletion, arbitrary remotes, and arbitrary refspecs are not supported.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (_input, extra) => {
    try {
      const { repositoryRoot, repository } = await repositoryContext(extra.signal);
      const branch = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        cwd: repositoryRoot,
        signal: extra.signal,
      });
      if (branch.exit_code !== 0) throw new Error("Cannot push a detached HEAD");
      const name = branch.stdout.trim();
      const valid = await run("git", ["check-ref-format", "--branch", name], {
        cwd: repositoryRoot,
        signal: extra.signal,
      });
      if (valid.exit_code !== 0) throw new Error("The current branch name is not a valid Git ref");
      return result({
        repository,
        branch: name,
        ...(await run("git", ["push", "--porcelain", "origin", `HEAD:refs/heads/${name}`], {
          cwd: repositoryRoot,
          signal: extra.signal,
        })),
      });
    } catch (error) {
      return failure(error);
    }
  },
);

await server.connect(new StdioServerTransport());
