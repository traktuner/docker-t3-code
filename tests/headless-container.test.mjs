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
  const installer = read("scripts/install-provider-clis.sh");
  const claudeLauncher = read("scripts/claude-launcher.sh");
  const doctor = read("scripts/t3-doctor.sh");

  assert.match(dockerfile, /^ARG T3_VERSION=latest$/m);
  assert.match(dockerfile, /^EXPOSE 3773$/m);
  assert.match(dockerfile, /scripts\/auth-proxy\.mjs/);
  assert.match(dockerfile, /scripts\/claude-launcher\.sh/);
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
  assert.match(entrypoint, /runtime-bin/);
  assert.match(entrypoint, /local binary="\$\{T3_OPENCODE_BINARY_PATH:-opencode\}"/);
  assert.match(entrypoint, /"\$\{server_env\[@\]\}" "\$binary" serve/);
  assert.match(installer, /--include=optional/);
  assert.match(claudeLauncher, /exec \"\$bundled\"/);
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
    assert.doesNotMatch(compose, /^\s+(ports:|privileged:|network_mode:|pid:)/m);
    assert.match(compose, /^    read_only: true$/m);
    assert.match(
      compose,
      /^    tmpfs:\n      - \/tmp:size=1G\n      - \/var\/tmp:size=500M\n      - \/data\/t3\/messages:size=200M$/m,
    );
    assert.match(
      compose,
      /^    cap_add:\n      - NET_BIND_SERVICE\n      - CHOWN\n      - SETGID\n      - SETUID$/m,
    );
    assert.equal(
      [...compose.matchAll(/^    cap_add:$/gm)].length,
      1,
      `${composeFile} must define one capability allowlist`,
    );
    assert.match(compose, /^      - no-new-privileges:true$/m);
    assert.match(compose, /^      - seccomp:unconfined$/m);
    assert.match(compose, /T3_AUTH_PROXY:/);
    assert.doesNotMatch(compose, /docker\.sock|T3_AUTH_WEB_HELPER/);
  }
});

test("keeps the repository T3 pin synchronized", () => {
  const workflow = read(".github/workflows/container.yml");
  assert.match(read(".env.example"), /^T3_VERSION=latest$/m);
  assert.match(workflow, /^\s+T3_VERSION: latest$/m);
  assert.match(workflow, /t3_version="\$\(npm view t3 version\)"/);
  assert.match(workflow, /explicit version .*forbidden/);
  assert.doesNotMatch(read("config/t3code.example.toml"), /^\[auth\]$/m);
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
