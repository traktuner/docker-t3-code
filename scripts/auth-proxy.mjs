#!/usr/bin/env node

import { execFile } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const listenHost = process.env.T3_AUTH_PROXY_LISTEN_HOST || "0.0.0.0";
const listenPort = Number.parseInt(process.env.T3_AUTH_PROXY_LISTEN_PORT || "3773", 10);
const upstreamHost = process.env.T3_AUTH_PROXY_UPSTREAM_HOST || "127.0.0.1";
const upstreamPort = Number.parseInt(process.env.T3_AUTH_PROXY_UPSTREAM_PORT || "13773", 10);
const t3Home = process.env.T3CODE_HOME || "/data/t3";
const t3Binary = process.env.T3_AUTH_PROXY_T3_BINARY || "/usr/local/bin/t3";
const adminTtl = process.env.T3_AUTH_PROXY_ADMIN_TTL || "2m";
const requestTimeoutMs = Number.parseInt(
  process.env.T3_AUTH_PROXY_REQUEST_TIMEOUT_MS || "15000",
  10,
);
const upstreamBase = `http://${upstreamHost}:${upstreamPort}`;
const adminScopes = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
  "relay:write",
  "access:read",
  "access:write",
];

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function upstreamRequestHeaders(headers, extra = {}) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!hopByHopHeaders.has(name.toLowerCase())) result[name] = value;
  }
  return { ...result, host: `${upstreamHost}:${upstreamPort}`, ...extra };
}

function downstreamResponseHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!hopByHopHeaders.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function cookieHeader(setCookies) {
  return setCookies
    .map((cookie) => cookie.split(";", 1)[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

function mergedCookieHeader(existing, setCookies) {
  return [existing, cookieHeader(setCookies)].filter(Boolean).join("; ");
}

function sendJson(res, status, body, setCookies = []) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const headers = {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json",
  };
  if (setCookies.length > 0) headers["set-cookie"] = setCookies;
  res.writeHead(status, headers);
  res.end(payload);
}

async function fetchUpstream(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(`${upstreamBase}${path}`, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function issueShortLivedAdministrativeToken() {
  const { stdout } = await execFileAsync(
    t3Binary,
    [
      "auth",
      "session",
      "issue",
      "--base-dir",
      t3Home,
      "--ttl",
      adminTtl,
      "--label",
      "Docker browser bootstrap",
      "--subject",
      "docker-browser-bootstrap",
      "--json",
    ],
    {
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: requestTimeoutMs,
    },
  );
  const result = JSON.parse(stdout);
  if (
    typeof result?.sessionId !== "string" ||
    result.sessionId.length === 0 ||
    typeof result?.token !== "string" ||
    result.token.length === 0
  ) {
    throw new Error("T3 did not issue the temporary administrative token.");
  }
  return { sessionId: result.sessionId, token: result.token };
}

async function revokeTemporaryAdministrativeToken(sessionId) {
  await execFileAsync(
    t3Binary,
    ["auth", "session", "revoke", "--base-dir", t3Home, sessionId],
    {
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: requestTimeoutMs,
    },
  );
}

async function issueOneTimePairingCredential(req, bearerToken) {
  const response = await fetchUpstream("/api/auth/pairing-token", {
    method: "POST",
    headers: upstreamRequestHeaders(req.headers, {
      accept: "application/json",
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      label: "Authenticated reverse-proxy browser",
      scopes: adminScopes,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`T3 pairing-token request returned HTTP ${response.status}.`);
  }
  const result = await response.json();
  if (typeof result?.credential !== "string" || result.credential.length === 0) {
    throw new Error("T3 did not issue the one-time pairing credential.");
  }
  return result.credential;
}

async function exchangeBrowserSession(req, credential) {
  return fetchUpstream("/api/auth/browser-session", {
    method: "POST",
    headers: upstreamRequestHeaders(req.headers, {
      accept: "application/json",
      "content-type": "application/json",
    }),
    body: JSON.stringify({ credential }),
  });
}

async function ensureBrowserSession(req, res) {
  const current = await fetchUpstream("/api/auth/session", {
    method: "GET",
    headers: upstreamRequestHeaders(req.headers, { accept: "application/json" }),
  });
  const currentText = await current.text();
  const currentCookies = getSetCookies(current.headers);

  let state;
  try {
    state = JSON.parse(currentText);
  } catch {
    res.writeHead(current.status, Object.fromEntries(current.headers));
    res.end(currentText);
    return;
  }

  if (state?.authenticated === true) {
    sendJson(res, current.status, currentText, currentCookies);
    return;
  }

  try {
    const administrative = await issueShortLivedAdministrativeToken();
    let credential;
    try {
      credential = await issueOneTimePairingCredential(req, administrative.token);
    } finally {
      try {
        await revokeTemporaryAdministrativeToken(administrative.sessionId);
      } catch (error) {
        console.warn(`T3 temporary browser bootstrap revocation failed: ${error.message}`);
      }
    }
    const exchanged = await exchangeBrowserSession(req, credential);
    if (!exchanged.ok) {
      await exchanged.body?.cancel();
      throw new Error(`T3 browser-session exchange returned HTTP ${exchanged.status}.`);
    }

    const browserCookies = getSetCookies(exchanged.headers);
    await exchanged.body?.cancel();
    const authenticated = await fetchUpstream("/api/auth/session", {
      method: "GET",
      headers: upstreamRequestHeaders(req.headers, {
        accept: "application/json",
        cookie: mergedCookieHeader(req.headers.cookie, browserCookies),
      }),
    });
    const authenticatedText = await authenticated.text();
    sendJson(res, authenticated.status, authenticatedText, [
      ...currentCookies,
      ...browserCookies,
      ...getSetCookies(authenticated.headers),
    ]);
  } catch (error) {
    console.warn(`T3 browser auto-session failed: ${error.message}`);
    sendJson(res, current.status, currentText, currentCookies);
  }
}

function proxyHttp(req, res) {
  const upstream = http.request(
    {
      hostname: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: upstreamRequestHeaders(req.headers),
    },
    (upstreamRes) => {
      res.writeHead(
        upstreamRes.statusCode || 502,
        downstreamResponseHeaders(upstreamRes.headers),
      );
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(`T3 upstream unavailable: ${error.message}\n`);
  });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    const headers = upstreamRequestHeaders(req.headers, {
      connection: "Upgrade",
      upgrade: req.headers.upgrade || "websocket",
    });
    for (const [name, value] of Object.entries(headers)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (item !== undefined) upstream.write(`${name}: ${item}\r\n`);
      }
    }
    upstream.write("\r\n");
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/api/auth/session")) {
    ensureBrowserSession(req, res).catch((error) => {
      console.warn(`T3 browser session handler failed: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("T3 browser session handler failed.\n");
    });
    return;
  }
  proxyHttp(req, res);
});

server.on("upgrade", proxyUpgrade);
server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});
server.listen(listenPort, listenHost, () => {
  console.log(`T3 browser proxy listening on ${listenHost}:${listenPort} -> ${upstreamBase}`);
});
