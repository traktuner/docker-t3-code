#!/usr/bin/env node
import { spawn } from "node:child_process";
import http from "node:http";

const LISTEN_HOST = process.env.T3_AUTH_WEB_HELPER_HOST || "0.0.0.0";
const LISTEN_PORT = Number.parseInt(process.env.T3_AUTH_WEB_HELPER_PORT || "13774", 10);
const AUTH_TOKEN = process.env.T3_AUTH_WEB_HELPER_TOKEN || "";
const REQUEST_LIMIT = 1024 * 1024;
const CALLBACK_TIMEOUT_MS = Number.parseInt(process.env.T3_AUTH_WEB_HELPER_CALLBACK_TIMEOUT_MS || "15000", 10);
const DEFAULT_COMMANDS = {
  opencode: ["t3-auth", "opencode", "mcp-auth", "{server}"],
};

function readCommands() {
  const raw = process.env.T3_AUTH_WEB_HELPER_COMMANDS_JSON || "";
  if (!raw.trim()) return DEFAULT_COMMANDS;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`T3_AUTH_WEB_HELPER_COMMANDS_JSON is invalid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("T3_AUTH_WEB_HELPER_COMMANDS_JSON must be an object of command arrays.");
  }
  for (const [name, command] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || !Array.isArray(command) || command.length === 0) {
      throw new Error(`Invalid auth helper command profile: ${name}`);
    }
    if (!command.every((argument) => typeof argument === "string" && argument.length > 0)) {
      throw new Error(`Auth helper command profile ${name} must contain non-empty strings.`);
    }
  }
  return parsed;
}

const COMMANDS = readCommands();

const state = {
  running: false,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  signal: null,
  profile: "",
  server: "",
  urls: [],
  logs: [],
  callbackResults: [],
  child: null,
};

function appendLog(line) {
  const text = String(line)
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .trimEnd();
  if (!text) return;
  state.logs.push(text);
  if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);

  const matches = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
  for (const rawUrl of matches) {
    const url = rawUrl.replace(/[).,;]+$/, "");
    if (!state.urls.includes(url)) state.urls.push(url);
  }
}

function resetState(profile, server) {
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.exitedAt = null;
  state.exitCode = null;
  state.signal = null;
  state.profile = profile;
  state.server = server;
  state.urls = [];
  state.logs = [];
  state.callbackResults = [];
}

function publicState() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    exitedAt: state.exitedAt,
    exitCode: state.exitCode,
    signal: state.signal,
    profile: state.profile,
    server: state.server,
    profiles: Object.keys(COMMANDS),
    urls: state.urls,
    logs: state.logs,
    callbackResults: state.callbackResults,
  };
}

function isAuthorized(req) {
  if (!AUTH_TOKEN) return true;
  const bearer = req.headers.authorization || "";
  const headerToken = req.headers["x-t3-auth-helper-token"] || "";
  return bearer === `Bearer ${AUTH_TOKEN}` || headerToken === AUTH_TOKEN;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readJson(req) {
  if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json");
    error.status = 415;
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > REQUEST_LIMIT) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function startAuth(profileName, serverName) {
  if (state.running) {
    const error = new Error("An auth flow is already running.");
    error.status = 409;
    throw error;
  }

  const profile = String(profileName || "opencode").trim();
  const commandTemplate = COMMANDS[profile];
  if (!commandTemplate) {
    const error = new Error(`Unknown auth helper profile: ${profile}`);
    error.status = 400;
    throw error;
  }

  const server = String(serverName || "cloudflare").trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(server)) {
    const error = new Error("MCP server name contains unsupported characters.");
    error.status = 400;
    throw error;
  }

  const command = commandTemplate.map((argument) => argument.replaceAll("{server}", server));
  if (!commandTemplate.some((argument) => argument.includes("{server}"))) command.push(server);

  resetState(profile, server);
  appendLog(`Starting ${profile} MCP auth for ${server}`);
  const child = spawn(command[0], command.slice(1), {
    env: process.env,
    cwd: process.env.T3_WORKDIR || "/workspace",
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child = child;

  child.stdout.on("data", (chunk) => appendLog(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => appendLog(chunk.toString("utf8")));
  child.on("error", (error) => {
    appendLog(`Failed to start auth command: ${error.message}`);
  });
  child.on("close", (code, signal) => {
    state.running = false;
    state.exitedAt = new Date().toISOString();
    state.exitCode = code;
    state.signal = signal;
    state.child = null;
    appendLog(`Auth command exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`);
  });
}

function stopAuth() {
  if (!state.running || !state.child) return false;
  appendLog("Stopping auth command");
  state.child.kill("SIGTERM");
  const child = state.child;
  setTimeout(() => {
    if (state.running && state.child === child) child.kill("SIGKILL");
  }, 3000).unref();
  return true;
}

function validateCallbackUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    const error = new Error("Callback URL is invalid.");
    error.status = 400;
    throw error;
  }
  if (parsed.protocol !== "http:") {
    const error = new Error("Only http:// loopback callback URLs are allowed.");
    error.status = 400;
    throw error;
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    const error = new Error("Only loopback callback URLs are allowed.");
    error.status = 400;
    throw error;
  }
  if (!state.running) {
    const error = new Error("No MCP auth flow is waiting for a callback.");
    error.status = 409;
    throw error;
  }

  const allowed = state.urls.flatMap((authorizationUrl) => {
    try {
      const redirect = new URL(authorizationUrl).searchParams.get("redirect_uri");
      return redirect ? [new URL(redirect)] : [];
    } catch {
      return [];
    }
  });
  if (!allowed.length) {
    const error = new Error("The auth command has not published a redirect_uri yet.");
    error.status = 409;
    throw error;
  }
  const matchesRedirect = allowed.some(
    (target) =>
      target.protocol === parsed.protocol &&
      target.hostname === parsed.hostname &&
      target.port === parsed.port &&
      target.pathname === parsed.pathname,
  );
  if (!matchesRedirect) {
    const error = new Error("Callback URL does not match the active OAuth redirect_uri.");
    error.status = 400;
    throw error;
  }
  return parsed.toString();
}

async function sendCallback(rawUrl) {
  const url = validateCallbackUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    await response.body?.cancel();
    const result = {
      at: new Date().toISOString(),
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
    };
    state.callbackResults.push(result);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function renderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>T3 Auth Helper</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #101113; color: #f5f5f5; }
    main { max-width: 960px; margin: 0 auto; padding: 32px 20px; }
    h1 { font-size: 28px; margin: 0 0 20px; }
    section { border: 1px solid #33373d; border-radius: 8px; padding: 18px; margin: 16px 0; background: #17191c; }
    label { display: block; font-weight: 650; margin: 0 0 8px; }
    input, select, textarea, button { font: inherit; }
    input, select, textarea { box-sizing: border-box; width: 100%; border: 1px solid #41464d; border-radius: 6px; padding: 10px 12px; background: #0f1012; color: #fff; }
    textarea { min-height: 86px; resize: vertical; }
    button { border: 0; border-radius: 6px; padding: 10px 14px; background: #3973f6; color: #fff; cursor: pointer; }
    button.secondary { background: #30343a; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .row { display: flex; gap: 10px; align-items: center; }
    .row > * { flex: 1; }
    .urls a { display: block; color: #8bb6ff; word-break: break-all; margin: 8px 0; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0b0c0e; border-radius: 6px; padding: 12px; min-height: 120px; max-height: 360px; overflow: auto; }
    .hint { color: #a4a9b1; line-height: 1.45; }
  </style>
</head>
<body>
<main>
  <h1>T3 Auth Helper</h1>
  <section>
    <div class="row">
      <div>
        <label for="profile">MCP client</label>
        <select id="profile"></select>
      </div>
      <div>
        <label for="server">MCP server</label>
        <input id="server" value="cloudflare" autocomplete="off">
      </div>
      <div style="flex:0 0 auto; align-self:end">
        <button id="start">Start auth</button>
        <button id="stop" class="secondary">Cancel</button>
      </div>
    </div>
    <p class="hint">Open the authorization URL below. If your browser lands on a failed 127.0.0.1 callback page, copy the full address bar URL and paste it into the callback box.</p>
  </section>
  <section>
    <label>Authorization URLs</label>
    <div id="urls" class="urls hint">No URL yet.</div>
  </section>
  <section>
    <label for="callback">Callback URL</label>
    <textarea id="callback" placeholder="http://127.0.0.1:19876/mcp/oauth/callback?code=...&state=..."></textarea>
    <div style="margin-top:10px"><button id="send">Send callback inside container</button></div>
  </section>
  <section>
    <label>Status</label>
    <pre id="status"></pre>
  </section>
</main>
<script>
const pageUrl = new URL(location.href);
const hashParams = new URLSearchParams(pageUrl.hash.slice(1));
const token = hashParams.get("token") || sessionStorage.getItem("t3AuthHelperToken") || "";
if (token) {
  sessionStorage.setItem("t3AuthHelperToken", token);
  history.replaceState(null, "", pageUrl.pathname);
}
const headers = token ? {"x-t3-auth-helper-token": token} : {};
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {"content-type": "application/json", ...headers, ...(options.headers || {})},
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Request failed");
  return json;
}
async function refresh() {
  try {
    const state = await api("/api/t3-auth-helper/status");
    document.getElementById("status").textContent = JSON.stringify(state, null, 2);
    const urls = document.getElementById("urls");
    urls.innerHTML = "";
    if (!state.urls.length) urls.textContent = "No URL yet.";
    for (const url of state.urls) {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.textContent = url;
      urls.appendChild(a);
    }
    document.getElementById("start").disabled = state.running;
    document.getElementById("stop").disabled = !state.running;
    const profile = document.getElementById("profile");
    if (!profile.options.length) {
      for (const name of state.profiles) profile.add(new Option(name, name));
    }
  } catch (error) {
    document.getElementById("status").textContent = error.message;
  }
}
document.getElementById("start").onclick = async () => {
  await api("/api/t3-auth-helper/start", {
    method: "POST",
    body: JSON.stringify({
      profile: document.getElementById("profile").value,
      server: document.getElementById("server").value || "cloudflare",
    }),
  });
  await refresh();
};
document.getElementById("stop").onclick = async () => {
  await api("/api/t3-auth-helper/stop", {method: "POST", body: "{}"});
  await refresh();
};
document.getElementById("send").onclick = async () => {
  await api("/api/t3-auth-helper/callback", {
    method: "POST",
    body: JSON.stringify({url: document.getElementById("callback").value}),
  });
  document.getElementById("callback").value = "";
  await refresh();
};
refresh();
setInterval(refresh, 1500);
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && (parsedUrl.pathname === "/" || parsedUrl.pathname === "/auth-tools")) {
    sendText(res, 200, renderHtml(), "text/html; charset=utf-8");
    return;
  }
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
    if (req.method === "GET" && parsedUrl.pathname === "/api/t3-auth-helper/status") {
      sendJson(res, 200, publicState());
      return;
    }
    if (req.method === "POST" && parsedUrl.pathname === "/api/t3-auth-helper/start") {
      const body = await readJson(req);
      startAuth(body.profile, body.server);
      sendJson(res, 202, publicState());
      return;
    }
    if (req.method === "POST" && parsedUrl.pathname === "/api/t3-auth-helper/stop") {
      sendJson(res, stopAuth() ? 202 : 200, publicState());
      return;
    }
    if (req.method === "POST" && parsedUrl.pathname === "/api/t3-auth-helper/callback") {
      const body = await readJson(req);
      const result = await sendCallback(body.url);
      sendJson(res, 200, { result, state: publicState() });
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message });
  }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`T3 auth helper listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
  if (!AUTH_TOKEN && !["127.0.0.1", "localhost", "::1"].includes(LISTEN_HOST)) {
    console.warn("T3 auth helper is listening beyond loopback without T3_AUTH_WEB_HELPER_TOKEN.");
  }
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    stopAuth();
    server.close(() => process.exit(0));
  });
}
