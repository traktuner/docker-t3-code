import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(root, "scripts", "t3-sandbox-only-plugin.js"),
  "utf8",
);
const pluginModule = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
const hooks = await pluginModule.T3SandboxOnly();

test("hard-blocks local execution tools regardless of agent permissions", async () => {
  for (const tool of ["bash", "read", "edit", "write", "grep", "glob", "task"]) {
    await assert.rejects(
      hooks["tool.execute.before"]({ tool }, { args: {} }),
      /Use the t3-sandbox MCP tools/,
    );
  }
});

test("does not block sandbox, Xcode, or arbitrary remote MCP tools", async () => {
  for (const tool of [
    "t3-sandbox_sandbox_create",
    "t3-sandbox_sandbox_exec",
    "xcodebuild_build",
    "cloudflare_search",
    "future-mcp_tool",
  ]) {
    await assert.doesNotReject(
      hooks["tool.execute.before"]({ tool }, { args: {} }),
    );
  }
});
