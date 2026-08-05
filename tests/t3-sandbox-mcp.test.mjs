import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(root, "scripts", "t3-sandbox-mcp.mjs"),
  "utf8",
);

test("registers a sandbox patch tool that validates before applying", () => {
  assert.match(source, /server\.registerTool\(\s*"sandbox_apply_patch"/);
  assert.match(source, /Buffer\.from\(patch, "utf8"\)\.toString\("base64"\)/);

  const validation = source.indexOf('git apply --check --whitespace=nowarn');
  const application = source.indexOf('git apply --whitespace=nowarn', validation + 1);
  assert.ok(validation >= 0, "the patch must be validated first");
  assert.ok(application > validation, "the validated patch must then be applied");
});
