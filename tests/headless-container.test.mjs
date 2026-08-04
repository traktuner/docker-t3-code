import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("pins the official T3 CLI and optionally wraps only its browser auth boundary", () => {
  const dockerfile = read("Dockerfile");
  const entrypoint = read("scripts/entrypoint.sh");
  const doctor = read("scripts/t3-doctor.sh");

  assert.match(dockerfile, /^ARG T3_VERSION=0\.0\.31$/m);
  assert.match(dockerfile, /^EXPOSE 3773$/m);
  assert.match(dockerfile, /scripts\/auth-proxy\.mjs/);
  assert.doesNotMatch(dockerfile, /mcp-auth-helper|EXPOSE[^\n]*13774/);

  assert.match(entrypoint, /local t3_binary=\/usr\/local\/bin\/t3/);
  for (const required of [
    "serve",
    "--mode web",
    '--host "$upstream_host"',
    '--port "$upstream_port"',
    '--base-dir "$T3CODE_HOME"',
    'args+=("$T3_WORKDIR")',
  ]) {
    assert.ok(entrypoint.includes(required), `missing headless argument: ${required}`);
  }
  assert.match(entrypoint, /node \/opt\/t3-docker\/auth-proxy\.mjs/);
  assert.match(entrypoint, /T3_AUTH_PROXY_INTERNAL_PORT/);
  assert.doesNotMatch(entrypoint, /T3_UPDATE_T3|project add/);
  assert.doesNotMatch(doctor, /T3_AUTH_PROXY|T3_AUTH_WEB_HELPER|auth helper/);
});

test("keeps T3 state, provider homes, and workspace as separate mounts", () => {
  for (const composeFile of ["docker-compose.yml", "docker-compose.example.yml"]) {
    const compose = read(composeFile);
    for (const target of [
      "target: /workspace",
      "target: /data/t3",
      "target: /data/home",
      "target: /data/codex",
      "target: /data/claude-home",
    ]) {
      assert.ok(compose.includes(target), `${composeFile} missing ${target}`);
    }
    assert.match(compose, /expose:\n\s+- "3773"/);
    assert.doesNotMatch(
      compose,
      /^\s+(ports:|privileged:|cap_add:|network_mode:|pid:)/m,
    );
    assert.match(compose, /T3_AUTH_PROXY:/);
    assert.doesNotMatch(compose, /docker\.sock|T3_AUTH_WEB_HELPER/);
  }
});

test("keeps the repository T3 pin synchronized", () => {
  assert.match(read(".env.example"), /^T3_VERSION=0\.0\.31$/m);
  assert.match(read(".github/workflows/container.yml"), /^\s+T3_VERSION: 0\.0\.31$/m);
  assert.match(read("docker-compose.yml"), /T3_VERSION:-0\.0\.31/);
  assert.match(read("docker-compose.example.yml"), /T3_VERSION:-0\.0\.31/);
  assert.doesNotMatch(read("config/t3code.example.toml"), /^\[auth\]$/m);
});

test("installs and validates Claude Code's platform-native optional binary", () => {
  const installer = read("scripts/install-provider-clis.sh");
  const entrypoint = read("scripts/entrypoint.sh");

  assert.match(installer, /--include=optional/);
  assert.match(
    installer,
    /node \/usr\/local\/lib\/node_modules\/@anthropic-ai\/claude-code\/install\.cjs/,
  );
  assert.match(installer, /claude --version >\/dev\/null/);
  assert.match(entrypoint, /Repairing unusable \$label package at current version/);
  assert.match(entrypoint, /npm_args\+=\(--include=optional\)/);
  assert.match(
    entrypoint,
    /"@anthropic-ai\/claude-code" "Claude Code" "claude" "install\.cjs"/,
  );
});

test("starts the sandbox MCP from sanitized harness environments", () => {
  const bridge = read("scripts/t3-sandbox-mcp.mjs");

  assert.match(
    bridge,
    /T3_SANDBOX_URL \|\| "http:\/\/t3-sandbox-gateway:8090"/,
  );
  assert.match(
    bridge,
    /T3_SANDBOX_TOKEN_FILE \|\|\s*"\/run\/t3-sandbox-secrets\/gateway-token"/,
  );
  assert.match(bridge, /readFileSync\(tokenFile, "utf8"\)\.trim\(\)/);
  assert.match(bridge, /!Array\.isArray\(value\)/);
});

test("registers the credential-isolated GitHub MCP for every provider harness", () => {
  const dockerfile = read("Dockerfile");
  const bridge = read("scripts/t3-github-mcp.mjs");
  const provisioner = read("scripts/provision-harness-mcp.sh");
  const cursor = read("scripts/configure-cursor-mcp.mjs");
  const instructions = read("scripts/t3-sandbox-instructions.md");

  assert.match(dockerfile, /scripts\/t3-github-mcp\.mjs/);
  assert.match(dockerfile, /usr\/local\/bin\/t3-github-mcp/);
  assert.match(bridge, /StreamableHTTPClientTransport/);
  assert.match(bridge, /gh", \["auth", "token"/);
  assert.doesNotMatch(bridge, /console\.log\(.*token/);
  for (const provider of ["codex", "claude", "grok"]) {
    assert.match(provisioner, new RegExp(`${provider} mcp add[^\\n]*github[^\\n]*t3-github-mcp`));
  }
  assert.match(cursor, /desired\.github = \{ command: "t3-github-mcp"/);
  assert.match(instructions, /Use the MCP server named `github`/);
  assert.match(instructions, /Never run authenticated `gh` commands inside `t3-sandbox`/);
});
