import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  combinePolicies,
  injectPolicyLine,
  readPolicy,
} from "../scripts/cursor-sandbox-wrapper.mjs";

function prompt(sessionId, text = "inspect the repository") {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text }],
    },
  });
}

test("injects the managed policy once per Cursor ACP session", () => {
  const sessions = new Set();
  const once = JSON.parse(injectPolicyLine(prompt("one"), "USE SANDBOX", sessions));
  const twice = JSON.parse(injectPolicyLine(prompt("one", "continue"), "USE SANDBOX", sessions));
  const other = JSON.parse(injectPolicyLine(prompt("two"), "USE SANDBOX", sessions));

  assert.match(once.params.prompt[0].text, /USE SANDBOX/);
  assert.equal(once.params.prompt[1].text, "inspect the repository");
  assert.equal(twice.params.prompt.length, 1);
  assert.match(other.params.prompt[0].text, /USE SANDBOX/);
});

test("passes non-prompt and malformed ACP lines through unchanged", () => {
  const sessions = new Set();
  const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });

  assert.equal(injectPolicyLine(initialize, "USE SANDBOX", sessions), initialize);
  assert.equal(injectPolicyLine("not-json", "USE SANDBOX", sessions), "not-json");
});

test("combines generic, sandbox-only, and both policies deterministically", () => {
  assert.equal(combinePolicies("USE POLICY", ""), "USE POLICY");
  assert.equal(combinePolicies("", "USE SANDBOX"), "USE SANDBOX");
  assert.equal(combinePolicies("USE POLICY\n", "\nUSE SANDBOX"), "USE POLICY\n\nUSE SANDBOX");
});

test("loads an optional generic policy and adds sandbox policy only when active", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-cursor-policy-"));
  const policy = path.join(directory, "policy.md");
  const sandbox = path.join(directory, "sandbox.md");
  fs.writeFileSync(policy, "USE POLICY\n");
  fs.writeFileSync(sandbox, "USE SANDBOX\n");

  assert.equal(readPolicy({ T3_CURSOR_POLICY_FILE: policy }), "USE POLICY");
  assert.equal(readPolicy({}), "");
  assert.equal(
    readPolicy({
      T3_CURSOR_POLICY_FILE: policy,
      T3_SANDBOX_URL: "http://sandbox",
      T3_HARNESS_SANDBOX_INSTRUCTIONS: "1",
      T3_HARNESS_SANDBOX_INSTRUCTIONS_FILE: sandbox,
    }),
    "USE POLICY\n\nUSE SANDBOX",
  );
  assert.equal(
    readPolicy({
      T3_CURSOR_POLICY_FILE: policy,
      T3_SANDBOX_URL: "http://sandbox",
      T3_HARNESS_SANDBOX_INSTRUCTIONS: "0",
      T3_HARNESS_SANDBOX_INSTRUCTIONS_FILE: sandbox,
    }),
    "USE POLICY",
  );
});
