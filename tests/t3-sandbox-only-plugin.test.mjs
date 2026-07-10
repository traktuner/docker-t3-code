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

test("hard-blocks local tools but leaves the sandbox-backed bash alias available", async () => {
  const hooks = await pluginModule.T3SandboxOnly();
  for (const tool of ["read", "edit", "write", "grep", "glob", "task"]) {
    await assert.rejects(
      hooks["tool.execute.before"]({ tool }, { args: {} }),
      /Do not retry it.*sandbox-backed bash/,
    );
  }
  for (const tool of [
    "bash",
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

test("marks blocked local tool definitions as unavailable before the model sees them", async () => {
  const hooks = await pluginModule.T3SandboxOnly();
  const output = { description: "Read a local file", parameters: {} };

  await hooks["tool.definition"]({ toolID: "read" }, output);

  assert.match(output.description, /unavailable.*sandbox-backed bash/i);
});

test("routes bash into one reused sandbox per OpenCode session", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.T3_SANDBOX_URL;
  const originalToken = process.env.T3_SANDBOX_TOKEN;
  const requests = [];
  process.env.T3_SANDBOX_URL = "http://sandbox-gateway:8090";
  process.env.T3_SANDBOX_TOKEN = "test-token";
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/v1/sandboxes")) {
      return new Response(
        JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        sandbox_id: "11111111-1111-4111-8111-111111111111",
        exit_code: 0,
        stdout: "/workspace/project\n",
        stderr: "",
      }),
      { status: 200 },
    );
  };

  try {
    const hooks = await pluginModule.T3SandboxOnly({
      directory: "/workspace/project",
      worktree: "/workspace/project",
    });
    const context = {
      sessionID: "session-one",
      directory: "/workspace/project",
      worktree: "/workspace/project",
    };
    const first = await hooks.tool.bash.execute({ command: "pwd" }, context);
    const second = await hooks.tool.bash.execute({ command: "git status" }, context);

    assert.equal(requests.length, 3);
    assert.equal(requests[0].url, "http://sandbox-gateway:8090/v1/sandboxes");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      workspace: "/workspace/project",
      profile: "auto",
      reuse: true,
    });
    assert.match(requests[1].url, /11111111-1111-4111-8111-111111111111\/exec$/);
    assert.equal(JSON.parse(requests[1].options.body).working_directory, "/workspace/project");
    assert.equal(first.output, "/workspace/project\n");
    assert.equal(second.metadata.sandbox_id, "11111111-1111-4111-8111-111111111111");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.T3_SANDBOX_URL;
    else process.env.T3_SANDBOX_URL = originalUrl;
    if (originalToken === undefined) delete process.env.T3_SANDBOX_TOKEN;
    else process.env.T3_SANDBOX_TOKEN = originalToken;
  }
});
