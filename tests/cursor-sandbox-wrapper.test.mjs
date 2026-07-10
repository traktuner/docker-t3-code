import assert from "node:assert/strict";
import test from "node:test";

import { injectPolicyLine } from "../scripts/cursor-sandbox-wrapper.mjs";

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
