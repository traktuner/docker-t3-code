import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "scripts", "t3-github-mcp.mjs"), "utf8");

test("exposes only bounded GitHub control-plane operations", () => {
  for (const tool of [
    "github_auth_status",
    "github_actions_list",
    "github_actions_watch",
    "github_actions_failed_log",
    "github_push_current_branch",
  ]) {
    assert.match(source, new RegExp(`server\\.registerTool\\(\\s*"${tool}"`));
  }
  assert.doesNotMatch(source, /auth", "token/);
  assert.ok(
    source.includes('["push", "--porcelain", "origin", `HEAD:refs/heads/${name}`]'),
    "the push must use the fixed origin/current-branch refspec",
  );
  assert.match(source, /Force-pushes, branch deletion, arbitrary remotes, and arbitrary refspecs are not supported/);
});

test("keeps authenticated commands inside the active workspace repository", () => {
  assert.match(source, /GitHub control tools are limited to/);
  assert.match(source, /The Git repository must be below/);
  assert.match(source, /origin is not a/);
});

test("teaches agents one direct GitHub route without sandbox fallback", () => {
  const policy = fs.readFileSync(path.join(root, "scripts", "t3-sandbox-instructions.md"), "utf8");
  for (const operation of [
    "github_push_current_branch",
    "github_actions_list",
    "github_actions_watch",
    "github_actions_failed_log",
    "github_auth_status",
  ]) {
    assert.match(policy, new RegExp(operation));
  }
  assert.match(policy, /Never run `gh`, `git push`, `gh run watch`, or `gh auth login` in the sandbox/);
  assert.match(policy, /do not probe alternate credentials or execution paths/);
});
