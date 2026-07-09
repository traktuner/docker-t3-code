#!/usr/bin/env node
import { execFile } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LISTEN_HOST = process.env.T3_AUTH_PROXY_LISTEN_HOST || process.env.T3_SERVER_HOST || "0.0.0.0";
const LISTEN_PORT = Number.parseInt(
  process.env.T3_AUTH_PROXY_LISTEN_PORT || process.env.T3_SERVER_PORT || "3773",
  10,
);
const UPSTREAM_HOST = process.env.T3_AUTH_PROXY_UPSTREAM_HOST || "127.0.0.1";
const UPSTREAM_PORT = Number.parseInt(process.env.T3_AUTH_PROXY_UPSTREAM_PORT || "13773", 10);
const T3CODE_HOME = process.env.T3CODE_HOME || "/data/t3";
const ADMIN_TTL =
  process.env.T3_AUTH_PROXY_ADMIN_TTL || process.env.T3_AUTH_PROXY_PAIRING_TTL || "2m";
const PAIRING_LABEL = process.env.T3_AUTH_PROXY_PAIRING_LABEL || "Docker browser auto-session";
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.T3_AUTH_PROXY_REQUEST_TIMEOUT_MS || "15000", 10);
const upstreamBase = `http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
const ADMIN_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
  "access:read",
  "access:write",
  "relay:write",
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

function filterHeaders(headers, extra = {}) {
  const next = {};
  for (const [name, value] of Object.entries(headers)) {
    if (hopByHopHeaders.has(name.toLowerCase())) {
      continue;
    }
    next[name] = value;
  }
  next.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  return { ...next, ...extra };
}

function responseSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function cookieHeaderFromSetCookies(setCookies) {
  return setCookies
    .map((cookie) => cookie.split(";", 1)[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

function mergeCookieHeaders(existingCookie, setCookies) {
  const issued = cookieHeaderFromSetCookies(setCookies);
  return [existingCookie, issued].filter(Boolean).join("; ");
}

function sendJson(res, status, body, setCookies = []) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const headers = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  };
  if (setCookies.length > 0) {
    headers["set-cookie"] = setCookies;
  }
  res.writeHead(status, headers);
  res.end(payload);
}

async function fetchUpstream(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${upstreamBase}${path}`, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function issueAdministrativeBearerToken() {
  const { stdout } = await execFileAsync(
    "t3",
    [
      "auth",
      "session",
      "issue",
      "--base-dir",
      T3CODE_HOME,
      "--ttl",
      ADMIN_TTL,
      "--label",
      "Docker auth proxy",
      "--subject",
      "docker-auth-proxy",
      "--json",
    ],
    {
      env: process.env,
      timeout: REQUEST_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );
  const parsed = JSON.parse(stdout);
  if (!parsed || typeof parsed.token !== "string" || parsed.token.length === 0) {
    throw new Error("T3 session command did not return a bearer token.");
  }
  return parsed.token;
}

async function issueAdministrativePairingCredential(req, bearerToken) {
  const response = await fetchUpstream("/api/auth/pairing-token", {
    method: "POST",
    headers: filterHeaders(req.headers, {
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/json",
      accept: "application/json",
    }),
    body: JSON.stringify({
      label: PAIRING_LABEL,
      scopes: ADMIN_SCOPES,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`T3 pairing-token endpoint returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed.credential !== "string" || parsed.credential.length === 0) {
    throw new Error("T3 pairing-token endpoint did not return a credential.");
  }
  return parsed.credential;
}

async function ensureBrowserSession(req, res) {
  const sessionHeaders = filterHeaders(req.headers, {
    accept: "application/json",
  });
  const sessionResponse = await fetchUpstream("/api/auth/session", {
    method: "GET",
    headers: sessionHeaders,
  });
  const sessionText = await sessionResponse.text();
  const sessionCookies = responseSetCookies(sessionResponse.headers);

  let sessionState;
  try {
    sessionState = JSON.parse(sessionText);
  } catch {
    res.writeHead(sessionResponse.status, Object.fromEntries(sessionResponse.headers));
    res.end(sessionText);
    return;
  }

  if (sessionState?.authenticated === true) {
    sendJson(res, sessionResponse.status, sessionText, sessionCookies);
    return;
  }

  try {
    const bearerToken = await issueAdministrativeBearerToken();
    const credential = await issueAdministrativePairingCredential(req, bearerToken);
    const browserSessionResponse = await fetchUpstream("/api/auth/browser-session", {
      method: "POST",
      headers: filterHeaders(req.headers, {
        "content-type": "application/json",
        accept: "application/json",
      }),
      body: JSON.stringify({ credential }),
    });

    if (!browserSessionResponse.ok) {
      const failureText = await browserSessionResponse.text();
      console.warn(
        `T3 auto browser-session exchange failed with HTTP ${browserSessionResponse.status}: ${failureText.slice(0, 200)}`,
      );
      sendJson(res, sessionResponse.status, sessionText, sessionCookies);
      return;
    }

    const browserSessionCookies = responseSetCookies(browserSessionResponse.headers);
    const authenticatedSessionResponse = await fetchUpstream("/api/auth/session", {
      method: "GET",
      headers: filterHeaders(req.headers, {
        accept: "application/json",
        cookie: mergeCookieHeaders(req.headers.cookie, browserSessionCookies),
      }),
    });
    const authenticatedSessionText = await authenticatedSessionResponse.text();
    const authenticatedCookies = [
      ...browserSessionCookies,
      ...responseSetCookies(authenticatedSessionResponse.headers),
    ];
    sendJson(
      res,
      authenticatedSessionResponse.status,
      authenticatedSessionText,
      authenticatedCookies,
    );
  } catch (error) {
    console.warn(`T3 auto browser-session bootstrap failed: ${error.message}`);
    sendJson(res, sessionResponse.status, sessionText, sessionCookies);
  }
}

function proxyHttp(req, res) {
  const upstreamReq = http.request(
    {
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: filterHeaders(req.headers),
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(`T3 upstream unavailable: ${error.message}\n`);
  });

  req.pipe(upstreamReq);
}

function proxyUpgrade(req, socket, head) {
  const upstreamSocket = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    upstreamSocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    const headers = filterHeaders(req.headers, {
      connection: "Upgrade",
      upgrade: req.headers.upgrade || "websocket",
    });
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          upstreamSocket.write(`${name}: ${item}\r\n`);
        }
      } else if (value !== undefined) {
        upstreamSocket.write(`${name}: ${value}\r\n`);
      }
    }
    upstreamSocket.write("\r\n");
    if (head.length > 0) {
      upstreamSocket.write(head);
    }
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
  });

  upstreamSocket.on("error", () => {
    socket.destroy();
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/api/auth/session")) {
    ensureBrowserSession(req, res).catch((error) => {
      console.warn(`T3 auth proxy session handling failed: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("T3 auth proxy failed.\n");
    });
    return;
  }

  proxyHttp(req, res);
});

server.on("upgrade", proxyUpgrade);
server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(
    `T3 auth proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> ${upstreamBase}`,
  );
});
