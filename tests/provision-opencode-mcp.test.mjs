import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provisioner = path.join(root, "scripts", "provision-opencode-mcp.mjs");

test("provisions global sandbox instructions and strict local-tool permissions idempotently", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-opencode-policy-"));
  const config = path.join(directory, "opencode.jsonc");
  fs.writeFileSync(
    config,
    JSON.stringify({ permission: { webfetch: "allow", bash: "allow" } }, null, 2),
  );

  const environment = {
    ...process.env,
    T3_OPENCODE_CLOUDFLARE_MCP: "off",
    T3_OPENCODE_MCP_PRESETS: "",
    T3_SANDBOX_MCP_RECONCILE: "0",
    T3_OPENCODE_SANDBOX_INSTRUCTIONS_FILE: "/config/t3-sandbox-instructions.md",
    T3_OPENCODE_SANDBOX_ONLY: "1",
  };
  execFileSync("node", [provisioner, config], { env: environment });
  const once = fs.readFileSync(config, "utf8");
  execFileSync("node", [provisioner, config], { env: environment });
  const twice = fs.readFileSync(config, "utf8");
  const parsed = JSON.parse(twice);

  assert.equal(once, twice);
  assert.deepEqual(parsed.instructions, ["/config/t3-sandbox-instructions.md"]);
  assert.equal(parsed.permission.webfetch, "allow");
  assert.equal(parsed.permission.bash, "deny");
  assert.equal(parsed.permission.read, "deny");
  assert.deepEqual(parsed.permission.task, {
    "*": "deny",
    "researcher-basic": "allow",
    "editor-basic": "allow",
    "implementer-plus": "allow",
    "reviewer-plus": "allow",
    "voter-basic": "allow",
    explore: "allow",
    general: "allow",
  });
  assert.equal(parsed.permission["t3-sandbox_*"], "allow");
  assert.equal(parsed.permission["xcodebuild_*"], "allow");
});
