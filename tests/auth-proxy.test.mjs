import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), 5000);
    const inspect = (chunk) => {
      output += chunk;
      if (pattern.test(output)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Proxy exited early with ${code}: ${output}`));
    });
  });
}

test("creates, preserves, and recovers a revoked browser session", async (t) => {
  const calls = { pairing: 0, exchange: 0 };
  let activeBrowserToken = null;
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/auth/session") {
      const authenticated =
        activeBrowserToken !== null &&
        req.headers.cookie?.includes(`t3_session=${activeBrowserToken}`) === true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ authenticated }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/auth/pairing-token") {
      calls.pairing += 1;
      assert.equal(req.headers.authorization, "Bearer admin-token");
      assert.equal(req.headers.cookie, undefined);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ credential: "pair-once" }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/auth/browser-session") {
      calls.exchange += 1;
      assert.equal(req.headers.cookie, undefined);
      activeBrowserToken = `browser-token-${calls.exchange}`;
      let body = "";
      for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body), { credential: "pair-once" });
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": `t3_session=${activeBrowserToken}; HttpOnly; SameSite=Lax; Path=/`,
      });
      res.end(JSON.stringify({ authenticated: true }));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("official-t3");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "t3-auth-proxy-"));
  const fakeT3 = path.join(temporary, "t3");
  fs.writeFileSync(
    fakeT3,
    [
      "#!/bin/sh",
      'case " $* " in',
      '  *" session issue "*) printf \'%s\\n\' \'{\"sessionId\":\"admin-session\",\"token\":\"admin-token\"}\' ;;',
      '  *" session revoke "*) printf \'%s\\n\' \'Revoked session admin-session.\' ;;',
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  const proxyPort = await unusedPort();
  const child = spawn(process.execPath, [path.join(root, "scripts/auth-proxy.mjs")], {
    env: {
      ...process.env,
      T3_AUTH_PROXY_ADMIN_TTL: "2m",
      T3_AUTH_PROXY_LISTEN_HOST: "127.0.0.1",
      T3_AUTH_PROXY_LISTEN_PORT: String(proxyPort),
      T3_AUTH_PROXY_T3_BINARY: fakeT3,
      T3_AUTH_PROXY_UPSTREAM_HOST: "127.0.0.1",
      T3_AUTH_PROXY_UPSTREAM_PORT: String(upstreamPort),
      T3CODE_HOME: temporary,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForOutput(child, /T3 browser proxy listening/);

  const first = await fetch(`http://127.0.0.1:${proxyPort}/api/auth/session`);
  assert.deepEqual(await first.json(), { authenticated: true });
  const sessionCookie = first.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("t3_session="));
  assert.ok(sessionCookie);
  assert.deepEqual(calls, { pairing: 1, exchange: 1 });

  const second = await fetch(`http://127.0.0.1:${proxyPort}/api/auth/session`, {
    headers: { cookie: sessionCookie.split(";", 1)[0] },
  });
  assert.deepEqual(await second.json(), { authenticated: true });
  assert.deepEqual(calls, { pairing: 1, exchange: 1 });

  activeBrowserToken = null;
  const recovered = await fetch(`http://127.0.0.1:${proxyPort}/api/auth/session`, {
    headers: { cookie: sessionCookie.split(";", 1)[0] },
  });
  assert.deepEqual(await recovered.json(), { authenticated: true });
  const recoveredCookie = recovered.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("t3_session="));
  assert.ok(recoveredCookie?.startsWith("t3_session=browser-token-2;"));
  assert.deepEqual(calls, { pairing: 2, exchange: 2 });

  const rootResponse = await fetch(`http://127.0.0.1:${proxyPort}/`);
  assert.equal(await rootResponse.text(), "official-t3");
});
