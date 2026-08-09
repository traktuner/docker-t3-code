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

test("combines STE-only, sandbox-only, and both policies deterministically", () => {
  assert.equal(combinePolicies("USE STE", ""), "USE STE");
  assert.equal(combinePolicies("", "USE SANDBOX"), "USE SANDBOX");
  assert.equal(combinePolicies("USE STE\n", "\nUSE SANDBOX"), "USE STE\n\nUSE SANDBOX");
});

test("loads mandatory STE without a sandbox and adds sandbox policy only when active", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-cursor-ste-"));
  const ste = path.join(directory, "ste.md");
  const sandbox = path.join(directory, "sandbox.md");
  fs.writeFileSync(ste, "USE STE\n");
  fs.writeFileSync(sandbox, "USE SANDBOX\n");

  assert.equal(readPolicy({ T3_STE100_POLICY_FILE: ste }), "USE STE");
  assert.equal(
    readPolicy({
      T3_STE100_POLICY_FILE: ste,
      T3_SANDBOX_URL: "http://sandbox",
      T3_HARNESS_SANDBOX_INSTRUCTIONS: "1",
      T3_HARNESS_SANDBOX_INSTRUCTIONS_FILE: sandbox,
    }),
    "USE STE\n\nUSE SANDBOX",
  );
  assert.equal(
    readPolicy({
      T3_STE100_POLICY_FILE: ste,
      T3_SANDBOX_URL: "http://sandbox",
      T3_HARNESS_SANDBOX_INSTRUCTIONS: "0",
      T3_HARNESS_SANDBOX_INSTRUCTIONS_FILE: sandbox,
    }),
    "USE STE",
  );
});
