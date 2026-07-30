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

  assert.match(dockerfile, /^ARG T3_VERSION=0\.0\.28$/m);
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
  assert.match(read(".env.example"), /^T3_VERSION=0\.0\.28$/m);
  assert.match(read(".github/workflows/container.yml"), /^\s+T3_VERSION: 0\.0\.28$/m);
  assert.doesNotMatch(read("config/t3code.example.toml"), /^\[auth\]$/m);
});
