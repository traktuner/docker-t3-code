#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  DEFAULT_LABELS,
  StateStore,
  actorAllowed,
  branchName,
  buildAgentPrompt,
  buildSearchQueries,
  changedPathLooksUnsafe,
  cleanAgentResponse,
  commitTitle,
  latestLabelActor,
  normalizeRepositories,
  parseAgentStatus,
  parseCsv,
  pullRequestTitle,
  redact,
  repositoryFromApiUrl,
  safeJobDirectory,
  textFromOpenCodeEvent,
} from "./github-issue-worker-lib.mjs";

const LABEL_METADATA = Object.freeze({
  ready: {
    color: "0e8a16",
    description: "Approved for autonomous implementation",
  },
  running: {
    color: "fbca04",
    description: "Autonomous implementation is running",
  },
  pullRequest: {
    color: "1d76db",
    description: "Autonomous implementation opened a draft PR",
  },
  complete: {
    color: "5319e7",
    description: "Autonomous issue task completed without a PR",
  },
  needsHuman: {
    color: "d93f0b",
    description: "Autonomous implementation needs human input",
  },
});

const activeChildren = new Set();
let stopping = false;
let wakePolling = null;

class GitHubApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

function integerEnv(name, fallback, minimum = 1) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

function booleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be boolean-like`);
}

function loadConfig() {
  const dataRoot = path.resolve(
    process.env.T3_ISSUE_WORKER_DATA_ROOT || "/data/issue-worker",
  );
  const workspaceRoot = path.resolve(
    process.env.T3_ISSUE_WORKER_WORKSPACE_ROOT || "/workspace",
  );
  const token = (process.env.T3_ISSUE_WORKER_GITHUB_TOKEN || "").trim();
  const sandboxToken = (process.env.T3_SANDBOX_TOKEN || "").trim();
  const sandboxUrl = (process.env.T3_SANDBOX_URL || "").replace(/\/$/, "");
  if (!token) throw new Error("T3_ISSUE_WORKER_GITHUB_TOKEN is required");
  if (!sandboxToken || !sandboxUrl)
    throw new Error("T3_SANDBOX_URL and T3_SANDBOX_TOKEN are required");

  return {
    token,
    lumoKey: process.env.LUMO_API_KEY || "",
    sandboxToken,
    sandboxUrl,
    apiUrl: (
      process.env.T3_ISSUE_WORKER_GITHUB_API_URL || "https://api.github.com"
    ).replace(/\/$/, ""),
    apiVersion: process.env.T3_ISSUE_WORKER_GITHUB_API_VERSION || "2026-03-10",
    serverUrl: (
      process.env.T3_ISSUE_WORKER_GITHUB_SERVER_URL || "https://github.com"
    ).replace(/\/$/, ""),
    repositories: normalizeRepositories(
      process.env.T3_ISSUE_WORKER_REPOSITORIES || "",
    ),
    allowedActors: parseCsv(process.env.T3_ISSUE_WORKER_ALLOWED_ACTORS || ""),
    model: process.env.T3_ISSUE_WORKER_MODEL || "proton/lumo-max",
    agent: process.env.T3_ISSUE_WORKER_AGENT || "github-issue-worker",
    promptSuffix: process.env.T3_ISSUE_WORKER_PROMPT_SUFFIX || "",
    branchPrefix: process.env.T3_ISSUE_WORKER_BRANCH_PREFIX || "t3-agent",
    gitName: process.env.T3_ISSUE_WORKER_GIT_NAME || "t3-issue-worker[bot]",
    gitEmail:
      process.env.T3_ISSUE_WORKER_GIT_EMAIL ||
      "t3-issue-worker[bot]@users.noreply.github.com",
    dataRoot,
    workspaceRoot,
    jobsRoot: path.join(workspaceRoot, ".t3-issue-worker", "jobs"),
    mirrorRoot: path.join(dataRoot, "mirrors"),
    logsRoot: path.join(dataRoot, "logs"),
    stateFile: path.join(dataRoot, "state.json"),
    heartbeatFile: path.join(dataRoot, "heartbeat"),
    pollSeconds: integerEnv("T3_ISSUE_WORKER_POLL_SECONDS", 60, 15),
    timeoutSeconds: integerEnv("T3_ISSUE_WORKER_TIMEOUT_SECONDS", 7200, 60),
    maxConcurrent: integerEnv("T3_ISSUE_WORKER_MAX_CONCURRENT", 1, 1),
    maxPerPoll: integerEnv("T3_ISSUE_WORKER_MAX_PER_POLL", 3, 1),
    maxPollFailures: integerEnv("T3_ISSUE_WORKER_MAX_POLL_FAILURES", 10, 1),
    maxLogBytes: integerEnv(
      "T3_ISSUE_WORKER_MAX_LOG_BYTES",
      52_428_800,
      1_048_576,
    ),
    keepFailedDays: integerEnv("T3_ISSUE_WORKER_KEEP_FAILED_DAYS", 14, 1),
    bootstrapLabels: booleanEnv("T3_ISSUE_WORKER_BOOTSTRAP_LABELS", true),
    allowCiChanges: booleanEnv("T3_ISSUE_WORKER_ALLOW_CI_CHANGES", false),
    labels: {
      ready: process.env.T3_ISSUE_WORKER_LABEL_READY || DEFAULT_LABELS.ready,
      running:
        process.env.T3_ISSUE_WORKER_LABEL_RUNNING || DEFAULT_LABELS.running,
      pullRequest:
        process.env.T3_ISSUE_WORKER_LABEL_PR || DEFAULT_LABELS.pullRequest,
      complete:
        process.env.T3_ISSUE_WORKER_LABEL_COMPLETE || DEFAULT_LABELS.complete,
      needsHuman:
        process.env.T3_ISSUE_WORKER_LABEL_NEEDS_HUMAN ||
        DEFAULT_LABELS.needsHuman,
    },
  };
}

function log(message, details = "") {
  const suffix = details ? ` ${details}` : "";
  process.stdout.write(`${new Date().toISOString()} ${message}${suffix}\n`);
}

function safeError(error, config) {
  return redact(
    error instanceof Error ? error.stack || error.message : String(error),
    [config.token, config.lumoKey, config.sandboxToken],
  );
}

class GitHubClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.reconciledLabels = new Set();
  }

  async request(endpoint, options = {}) {
    const response = await this.fetch(`${this.config.apiUrl}${endpoint}`, {
      method: options.method || "GET",
      headers: {
        accept: options.accept || "application/vnd.github+json",
        authorization: `Bearer ${this.config.token}`,
        "content-type": "application/json",
        "user-agent": "t3-code-issue-worker/1",
        "x-github-api-version": this.config.apiVersion,
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs || 30_000),
    });
    const raw = await response.text();
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw.slice(0, 2_000);
      }
    }
    const accepted = options.acceptStatus || [200];
    if (!accepted.includes(response.status)) {
      const detail =
        typeof data === "object" && data?.message
          ? data.message
          : String(data || "");
      throw new GitHubApiError(
        `GitHub API ${options.method || "GET"} ${endpoint} returned ${response.status}: ${detail}`,
        response.status,
      );
    }
    return { data, headers: response.headers, status: response.status };
  }

  async paginate(endpoint, maximumPages = 10) {
    const items = [];
    for (let page = 1; page <= maximumPages; page += 1) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const { data } = await this.request(
        `${endpoint}${separator}per_page=100&page=${page}`,
      );
      if (!Array.isArray(data))
        throw new Error(`Expected an array from ${endpoint}`);
      items.push(...data);
      if (data.length < 100) break;
    }
    return items;
  }

  async currentUser() {
    return (await this.request("/user")).data;
  }

  async repositories() {
    if (this.config.repositories.length) return this.config.repositories;
    const items = await this.paginate(
      "/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name",
    );
    return items
      .filter((repo) => !repo.archived && !repo.disabled)
      .map((repo) => repo.full_name);
  }

  async ensureLabels(repository) {
    if (this.reconciledLabels.has(repository)) return;
    const [owner, repo] = repository.split("/").map(encodeURIComponent);
    const endpoint = `/repos/${owner}/${repo}/labels`;
    const existing = new Set(
      (await this.paginate(endpoint)).map((label) => label.name),
    );
    for (const [kind, metadata] of Object.entries(LABEL_METADATA)) {
      const name = this.config.labels[kind];
      if (existing.has(name)) continue;
      await this.request(endpoint, {
        method: "POST",
        acceptStatus: [201],
        body: {
          name,
          color: metadata.color,
          description: metadata.description,
        },
      });
    }
    this.reconciledLabels.add(repository);
  }

  async searchByLabel(label, maximum) {
    const queries = buildSearchQueries({
      repositories: this.config.repositories,
      readyLabel: label,
      maximum,
    });
    const found = new Map();
    for (const { query, perPage } of queries) {
      const params = new URLSearchParams({
        q: query,
        sort: "created",
        order: "asc",
        per_page: String(perPage),
      });
      const data = (await this.request(`/search/issues?${params}`)).data;
      for (const issue of data.items || []) {
        if (issue.pull_request) continue;
        const repository = repositoryFromApiUrl(issue.repository_url);
        found.set(`${repository}#${issue.number}`, { repository, issue });
      }
    }
    return [...found.values()].slice(0, maximum);
  }

  async issue(repository, number) {
    return (await this.request(`/repos/${repository}/issues/${number}`)).data;
  }

  async comments(repository, number) {
    return this.paginate(`/repos/${repository}/issues/${number}/comments`);
  }

  async timeline(repository, number) {
    return this.paginate(`/repos/${repository}/issues/${number}/timeline`);
  }

  async repository(repository) {
    return (await this.request(`/repos/${repository}`)).data;
  }

  async addLabels(repository, number, labels) {
    await this.request(`/repos/${repository}/issues/${number}/labels`, {
      method: "POST",
      body: { labels },
    });
  }

  async removeLabel(repository, number, label) {
    await this.request(
      `/repos/${repository}/issues/${number}/labels/${encodeURIComponent(label)}`,
      {
        method: "DELETE",
        acceptStatus: [200, 204, 404],
      },
    );
  }

  async comment(repository, number, body) {
    return (
      await this.request(`/repos/${repository}/issues/${number}/comments`, {
        method: "POST",
        acceptStatus: [201],
        body: { body: body.slice(0, 65_000) },
      })
    ).data;
  }

  async createDraftPullRequest(repository, body) {
    return (
      await this.request(`/repos/${repository}/pulls`, {
        method: "POST",
        acceptStatus: [201],
        body: { ...body, draft: true },
      })
    ).data;
  }
}

function strippedEnvironment(extra = {}) {
  const allowed = [
    "PATH",
    "LANG",
    "LC_ALL",
    "TZ",
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "OPENCODE_CONFIG_DIR",
    "NPM_CONFIG_PREFIX",
    "NPM_CONFIG_CACHE",
    "npm_config_prefix",
    "npm_config_cache",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
  ];
  const env = Object.fromEntries(
    allowed.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  return { ...env, ...extra };
}

function gitEnvironment(config, authenticated) {
  return strippedEnvironment({
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/opt/t3-docker/github-git-askpass.sh",
    SSH_ASKPASS: "/opt/t3-docker/github-git-askpass.sh",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...(authenticated
      ? { T3_GIT_USERNAME: "x-access-token", T3_GIT_PASSWORD: config.token }
      : {}),
  });
}

function openCodeEnvironment(config, workspace) {
  const prefixes = ["T3_SANDBOX_", "T3_XCODE_"];
  const bridge = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        prefixes.some((prefix) => key.startsWith(prefix)),
    ),
  );
  delete bridge.T3_SANDBOX_TOKEN_FILE;
  return strippedEnvironment({
    ...bridge,
    LUMO_API_KEY: config.lumoKey,
    T3_SANDBOX_TOKEN: config.sandboxToken,
    T3_SANDBOX_WORKSPACE: workspace,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    XCODEBUILDMCP_SENTRY_DISABLED: "true",
    CI: "true",
    NO_COLOR: "1",
  });
}

function terminate(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited.
    }
  }
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeout = null;
    const captureLimit = options.captureLimit || 2_000_000;
    const append = (current, chunk) =>
      `${current}${chunk}`.slice(-captureLimit);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk.toString("utf8"));
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk.toString("utf8"));
      options.onStderr?.(chunk);
    });
    child.once("error", (error) => {
      activeChildren.delete(child);
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate(child);
          setTimeout(() => terminate(child, "SIGKILL"), 10_000).unref();
        }, options.timeoutMs)
      : null;
    timeout?.unref();
    child.once("close", (code, signal) => {
      activeChildren.delete(child);
      if (timeout) clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

const GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "advice.detachedHead=false",
];

async function git(config, args, options = {}) {
  const result = await runProcess("git", [...GIT_CONFIG, ...args], {
    cwd: options.cwd,
    env: gitEnvironment(config, options.authenticated || false),
    timeoutMs: options.timeoutMs || 600_000,
    captureLimit: options.captureLimit,
  });
  const accepted = options.acceptCodes || [0];
  if (!accepted.includes(result.code)) {
    throw new Error(
      `git ${args[0]} failed (${result.code ?? result.signal}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

async function prepareWorkspace(config, repository, issue, repoData, runId) {
  const [owner, name] = repository.split("/");
  const mirror = path.join(config.mirrorRoot, owner, `${name}.git`);
  const workspace = safeJobDirectory(
    config.jobsRoot,
    repository,
    issue.number,
    runId,
  );
  const cloneUrl = `${config.serverUrl}/${repository}.git`;
  await fsp.mkdir(path.dirname(mirror), { recursive: true });
  await fsp.mkdir(path.dirname(workspace), { recursive: true });

  let mirrorExists = true;
  try {
    await fsp.access(path.join(mirror, "HEAD"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    mirrorExists = false;
  }
  if (mirrorExists) {
    await git(config, ["-C", mirror, "remote", "set-url", "origin", cloneUrl]);
    await git(config, ["-C", mirror, "remote", "update", "--prune"], {
      authenticated: true,
    });
  } else {
    const temporary = `${mirror}.tmp-${runId}`;
    await safeRemoveDirectory(temporary, path.dirname(mirror), null);
    await git(
      config,
      ["clone", "--mirror", "--filter=blob:none", cloneUrl, temporary],
      { authenticated: true },
    );
    await fsp.rename(temporary, mirror);
  }

  await git(
    config,
    [
      "clone",
      "--no-tags",
      "--reference-if-able",
      mirror,
      "--dissociate",
      cloneUrl,
      workspace,
    ],
    { authenticated: true, timeoutMs: 1_800_000 },
  );
  const branch = branchName(
    issue.number,
    new Date(),
    config.branchPrefix,
    runId.slice(-6),
  );
  const baseCommit = (
    await git(
      config,
      [
        "rev-parse",
        "--verify",
        `refs/remotes/origin/${repoData.default_branch}^{commit}`,
      ],
      {
        cwd: workspace,
      },
    )
  ).stdout.trim();
  await git(config, ["checkout", "-b", branch, baseCommit], { cwd: workspace });
  await git(config, ["config", "user.name", config.gitName], {
    cwd: workspace,
  });
  await git(config, ["config", "user.email", config.gitEmail], {
    cwd: workspace,
  });
  await fsp.writeFile(
    path.join(workspace, ".git", "t3-issue-worker-marker"),
    `${runId}\n`,
    { mode: 0o600 },
  );
  return {
    workspace,
    branch,
    base: repoData.default_branch,
    baseCommit,
    cloneUrl,
  };
}

async function readInstructions(workspace) {
  const result = [];
  for (const name of ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]) {
    try {
      result.push({
        name,
        content: await fsp.readFile(path.join(workspace, name), "utf8"),
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return result;
}

async function runOpenCode(config, job, prompt, logFile) {
  await fsp.mkdir(path.dirname(logFile), { recursive: true });
  const output = fs.createWriteStream(logFile, { flags: "a", mode: 0o600 });
  let written = 0;
  let pending = "";
  let response = "";
  const write = (prefix, chunk) => {
    if (written >= config.maxLogBytes) return;
    const value = Buffer.from(`${prefix}${chunk.toString("utf8")}`);
    const remaining = config.maxLogBytes - written;
    output.write(value.subarray(0, remaining));
    written += Math.min(value.length, remaining);
  };
  const parse = (chunk) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) {
      const text = textFromOpenCodeEvent(line);
      if (text) response = text;
    }
  };

  let result;
  try {
    result = await runProcess(
      "opencode",
      [
        "run",
        "--format",
        "json",
        "--model",
        config.model,
        "--agent",
        config.agent,
        "--dir",
        job.workspace,
      ],
      {
        cwd: job.workspace,
        env: openCodeEnvironment(config, job.workspace),
        input: prompt,
        timeoutMs: config.timeoutSeconds * 1000,
        captureLimit: 500_000,
        onStdout: (chunk) => {
          write("", chunk);
          parse(chunk);
        },
        onStderr: (chunk) => write("[stderr] ", chunk),
      },
    );
  } finally {
    await new Promise((resolve) => output.end(resolve));
  }
  if (pending) {
    const text = textFromOpenCodeEvent(pending);
    if (text) response = text;
  }
  if (result.timedOut)
    throw new Error(`OpenCode exceeded ${config.timeoutSeconds} seconds`);
  if (result.code !== 0)
    throw new Error(
      `OpenCode failed with exit code ${result.code}: ${result.stderr.slice(-4_000)}`,
    );
  if (!response) throw new Error("OpenCode returned no final response");
  return response;
}

async function hashFile(file) {
  return crypto
    .createHash("sha256")
    .update(await fsp.readFile(file))
    .digest("hex");
}

async function validateGitMetadata(config, job, expectedConfigHash) {
  const currentHash = await hashFile(
    path.join(job.workspace, ".git", "config"),
  );
  if (currentHash !== expectedConfigHash)
    throw new Error("Agent changed protected Git metadata");
  const branch = (
    await git(config, ["branch", "--show-current"], { cwd: job.workspace })
  ).stdout.trim();
  if (branch !== job.branch)
    throw new Error(
      `Agent switched Git branch to ${branch || "detached HEAD"}`,
    );
  const remote = (
    await git(config, ["remote", "get-url", "origin"], { cwd: job.workspace })
  ).stdout.trim();
  if (remote !== job.cloneUrl)
    throw new Error("Agent changed the Git origin URL");
  const baseCommit = (
    await git(
      config,
      ["rev-parse", "--verify", `refs/remotes/origin/${job.base}^{commit}`],
      {
        cwd: job.workspace,
      },
    )
  ).stdout.trim();
  if (baseCommit !== job.baseCommit)
    throw new Error("Agent changed the protected base reference");
  const ancestor = await git(
    config,
    ["merge-base", "--is-ancestor", job.baseCommit, "HEAD"],
    {
      cwd: job.workspace,
      acceptCodes: [0, 1],
    },
  );
  if (ancestor.code !== 0)
    throw new Error(
      "Agent history no longer descends from the protected base commit",
    );
}

async function destroyJobSandboxes(config, workspace) {
  const headers = { authorization: `Bearer ${config.sandboxToken}` };
  const list = await fetch(`${config.sandboxUrl}/v1/sandboxes`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!list.ok)
    throw new Error(`Sandbox cleanup list failed with HTTP ${list.status}`);
  const sandboxes = await list.json();
  if (!Array.isArray(sandboxes))
    throw new Error("Sandbox cleanup returned an invalid list");
  const activeStates = new Set(["creating", "active", "unavailable"]);
  for (const sandbox of sandboxes) {
    if (sandbox?.workspace !== workspace || !activeStates.has(sandbox?.state))
      continue;
    const response = await fetch(
      `${config.sandboxUrl}/v1/sandboxes/${encodeURIComponent(sandbox.id)}`,
      {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (![204, 404].includes(response.status)) {
      throw new Error(`Sandbox cleanup failed with HTTP ${response.status}`);
    }
  }
}

async function changedFiles(config, job) {
  const [staged, committed] = await Promise.all([
    git(config, ["diff", "--cached", "--name-only", "-z"], {
      cwd: job.workspace,
    }),
    git(config, ["diff", "--name-only", "-z", `origin/${job.base}...HEAD`], {
      cwd: job.workspace,
    }),
  ]);
  return [
    ...new Set(
      `${staged.stdout}\0${committed.stdout}`.split("\0").filter(Boolean),
    ),
  ];
}

async function scanChanges(config, job, files) {
  const secrets = [config.token, config.lumoKey, config.sandboxToken].filter(
    (value) => value.length >= 8,
  );
  for (const file of files) {
    if (
      changedPathLooksUnsafe(file, { allowCiChanges: config.allowCiChanges })
    ) {
      throw new Error(`Refusing to publish protected path: ${file}`);
    }
    const fullPath = path.resolve(job.workspace, file);
    if (!fullPath.startsWith(`${path.resolve(job.workspace)}${path.sep}`))
      throw new Error("Changed path escaped workspace");
    let stat;
    try {
      stat = await fsp.lstat(fullPath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.size > 20_000_000) continue;
    const content = await fsp.readFile(fullPath);
    for (const secret of secrets) {
      if (content.includes(Buffer.from(secret)))
        throw new Error(`Refusing to publish a credential found in ${file}`);
    }
  }
}

async function publishChanges(
  config,
  client,
  repository,
  issue,
  repoData,
  job,
  response,
) {
  await git(config, ["diff", "--check", "HEAD"], { cwd: job.workspace });
  await git(
    config,
    ["diff", "--check", `origin/${repoData.default_branch}...HEAD`],
    { cwd: job.workspace },
  );
  await git(config, ["add", "-A"], { cwd: job.workspace });
  const files = await changedFiles(config, job);
  await scanChanges(config, job, files);
  const staged = await git(config, ["diff", "--cached", "--quiet"], {
    cwd: job.workspace,
    acceptCodes: [0, 1],
  });
  if (staged.code === 1) {
    await git(config, ["commit", "-m", commitTitle(issue)], {
      cwd: job.workspace,
    });
  }
  const ahead = Number.parseInt(
    (
      await git(
        config,
        ["rev-list", "--count", `origin/${repoData.default_branch}..HEAD`],
        { cwd: job.workspace },
      )
    ).stdout.trim(),
    10,
  );
  if (!Number.isInteger(ahead) || ahead < 1) return null;

  const lfs = await git(config, ["lfs", "ls-files", "--name-only"], {
    cwd: job.workspace,
    acceptCodes: [0, 1],
  });
  const lfsFiles = new Set(
    lfs.stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (files.some((file) => lfsFiles.has(file))) {
    const lfsUrl = `${config.serverUrl}/${repository}.git/info/lfs`;
    await git(
      config,
      ["-c", `lfs.url=${lfsUrl}`, "lfs", "push", "origin", job.branch],
      {
        cwd: job.workspace,
        authenticated: true,
        timeoutMs: 1_800_000,
      },
    );
  }

  await git(config, ["push", "--set-upstream", "origin", job.branch], {
    cwd: job.workspace,
    authenticated: true,
    timeoutMs: 1_800_000,
  });
  const body = [
    cleanAgentResponse(response) || "Implemented the requested issue.",
    "",
    `Closes #${issue.number}`,
    "",
    "Generated by the unattended T3/OpenCode issue worker. This pull request is intentionally a draft and is never merged automatically.",
  ].join("\n");
  return client.createDraftPullRequest(repository, {
    title: pullRequestTitle(issue),
    head: job.branch,
    base: repoData.default_branch,
    body,
  });
}

async function transition(client, config, repository, number, target) {
  await client.addLabels(repository, number, [config.labels[target]]);
  for (const label of [config.labels.ready, config.labels.running]) {
    await client.removeLabel(repository, number, label);
  }
}

async function claimIssue(client, config, tokenLogin, repository, searchIssue) {
  await client.ensureLabels(repository);
  const issue = await client.issue(repository, searchIssue.number);
  const names = new Set(
    (issue.labels || []).map((label) =>
      typeof label === "string" ? label : label.name,
    ),
  );
  if (!names.has(config.labels.ready) || names.has(config.labels.running))
    return null;
  const events = await client.timeline(repository, issue.number);
  const actor = latestLabelActor(events, config.labels.ready);
  if (!actorAllowed(actor, tokenLogin, config.allowedActors)) {
    await transition(client, config, repository, issue.number, "needsHuman");
    await client.comment(
      repository,
      issue.number,
      "The autonomous run was not started because the `agent-ready` label was not applied by an allowed actor.",
    );
    return null;
  }
  for (const label of [
    config.labels.pullRequest,
    config.labels.complete,
    config.labels.needsHuman,
  ]) {
    await client.removeLabel(repository, issue.number, label);
  }
  await client.addLabels(repository, issue.number, [config.labels.running]);
  await client.removeLabel(repository, issue.number, config.labels.ready);
  return issue;
}

async function processIssue({
  client,
  config,
  state,
  tokenLogin,
  repository,
  searchIssue,
}) {
  const key = `${repository}#${searchIssue.number}`;
  const runId = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  let job = null;
  try {
    const issue = await claimIssue(
      client,
      config,
      tokenLogin,
      repository,
      searchIssue,
    );
    if (!issue) return;
    const repoData = await client.repository(repository);
    job = await prepareWorkspace(config, repository, issue, repoData, runId);
    const logFile = path.join(
      config.logsRoot,
      repository,
      `issue-${issue.number}-${runId}.jsonl`,
    );
    await state.start(key, {
      repository,
      number: issue.number,
      runId,
      workspace: job.workspace,
      startedAt: new Date().toISOString(),
    });
    const [comments, instructions] = await Promise.all([
      client.comments(repository, issue.number),
      readInstructions(job.workspace),
    ]);
    const prompt = buildAgentPrompt({
      issue,
      comments,
      instructions,
      workspace: job.workspace,
      suffix: config.promptSuffix,
    });
    const configHash = await hashFile(
      path.join(job.workspace, ".git", "config"),
    );
    log("Starting issue", key);
    let response;
    try {
      response = await runOpenCode(config, job, prompt, logFile);
    } finally {
      await destroyJobSandboxes(config, job.workspace);
    }
    await validateGitMetadata(config, job, configHash);
    const status = parseAgentStatus(response);
    if (status !== "complete") {
      await client.comment(
        repository,
        issue.number,
        cleanAgentResponse(response) ||
          "The autonomous worker needs human input.",
      );
      await transition(client, config, repository, issue.number, "needsHuman");
      log("Issue needs human input", key);
      return;
    }

    const pullRequest = await publishChanges(
      config,
      client,
      repository,
      issue,
      repoData,
      job,
      response,
    );
    if (pullRequest) {
      await client.comment(
        repository,
        issue.number,
        `Draft pull request created: ${pullRequest.html_url}`,
      );
      await transition(client, config, repository, issue.number, "pullRequest");
      await safeRemoveDirectory(job.workspace, config.jobsRoot, runId);
      log("Draft pull request created", `${key} ${pullRequest.html_url}`);
    } else {
      await client.comment(
        repository,
        issue.number,
        cleanAgentResponse(response) ||
          "The issue was analyzed; no repository changes were required.",
      );
      await transition(client, config, repository, issue.number, "complete");
      await safeRemoveDirectory(job.workspace, config.jobsRoot, runId);
      log("Issue completed without changes", key);
    }
  } catch (error) {
    log("Issue failed", `${key}\n${safeError(error, config)}`);
    try {
      await client.ensureLabels(repository);
      await client.comment(
        repository,
        searchIssue.number,
        "The autonomous run stopped safely and needs human inspection. Its workspace and local logs were retained; no automatic merge was attempted.",
      );
      await transition(
        client,
        config,
        repository,
        searchIssue.number,
        "needsHuman",
      );
    } catch (reportError) {
      log("Could not report issue failure", safeError(reportError, config));
      throw reportError;
    }
  } finally {
    await state.finish(key);
  }
}

async function safeRemoveDirectory(target, root, runId) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (
    resolvedTarget === resolvedRoot ||
    !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  )
    return;
  if (runId !== null) {
    const marker = path.join(resolvedTarget, ".git", "t3-issue-worker-marker");
    try {
      if ((await fsp.readFile(marker, "utf8")).trim() !== runId) return;
    } catch {
      return;
    }
  }
  await fsp.rm(resolvedTarget, { recursive: true, force: true });
}

async function cleanupRetainedJobs(config) {
  const cutoff = Date.now() - config.keepFailedDays * 86_400_000;
  let owners = [];
  try {
    owners = await fsp.readdir(config.jobsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const owner of owners.filter((entry) => entry.isDirectory())) {
    const ownerPath = path.join(config.jobsRoot, owner.name);
    const repositories = await fsp.readdir(ownerPath, { withFileTypes: true });
    for (const repository of repositories.filter((entry) =>
      entry.isDirectory(),
    )) {
      const repositoryPath = path.join(ownerPath, repository.name);
      const jobs = await fsp.readdir(repositoryPath, { withFileTypes: true });
      for (const job of jobs.filter((entry) => entry.isDirectory())) {
        const jobPath = path.join(repositoryPath, job.name);
        const marker = path.join(jobPath, ".git", "t3-issue-worker-marker");
        try {
          const stat = await fsp.stat(marker);
          if (stat.mtimeMs >= cutoff) continue;
          const runId = (await fsp.readFile(marker, "utf8")).trim();
          await safeRemoveDirectory(jobPath, config.jobsRoot, runId);
          log("Removed expired retained workspace", job.name);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
  }
}

async function cleanupRetainedLogs(config) {
  const cutoff = Date.now() - config.keepFailedDays * 86_400_000;
  let entries;
  try {
    entries = await fsp.readdir(config.logsRoot, { recursive: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const root = path.resolve(config.logsRoot);
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const target = path.resolve(root, entry);
    if (!target.startsWith(`${root}${path.sep}`)) continue;
    const stat = await fsp.stat(target);
    if (stat.isFile() && stat.mtimeMs < cutoff) await fsp.unlink(target);
  }
}

async function runLimited(items, limit, operation) {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length && !stopping) {
        const item = queue.shift();
        if (item) await operation(item);
      }
    },
  );
  await Promise.all(workers);
}

async function recoverStaleJobs(client, config) {
  const stale = await client.searchByLabel(config.labels.running, 100);
  for (const { repository, issue } of stale) {
    try {
      await client.ensureLabels(repository);
      await client.comment(
        repository,
        issue.number,
        "The issue worker restarted while this run was active. It was stopped conservatively and requires inspection before retrying.",
      );
      await transition(client, config, repository, issue.number, "needsHuman");
    } catch (error) {
      log(
        "Could not recover stale issue",
        `${repository}#${issue.number} ${safeError(error, config)}`,
      );
    }
  }
}

async function bootstrapLabels(client, config) {
  if (!config.bootstrapLabels) return;
  const repositories = await client.repositories();
  await runLimited(repositories, 4, async (repository) => {
    try {
      await client.ensureLabels(repository);
    } catch (error) {
      log(
        "Could not bootstrap labels",
        `${repository} ${safeError(error, config)}`,
      );
    }
  });
  log("GitHub labels reconciled", `${repositories.length} repositories`);
}

async function writeHeartbeat(config) {
  await fsp.mkdir(path.dirname(config.heartbeatFile), { recursive: true });
  await fsp.writeFile(config.heartbeatFile, `${new Date().toISOString()}\n`, {
    mode: 0o600,
  });
}

async function waitForNextPoll(milliseconds) {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    wakePolling = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  wakePolling = null;
}

async function healthcheck() {
  const dataRoot = path.resolve(
    process.env.T3_ISSUE_WORKER_DATA_ROOT || "/data/issue-worker",
  );
  const pollSeconds = integerEnv("T3_ISSUE_WORKER_POLL_SECONDS", 60, 15);
  const stat = await fsp.stat(path.join(dataRoot, "heartbeat"));
  if (Date.now() - stat.mtimeMs > Math.max(180, pollSeconds * 4) * 1000)
    process.exit(1);
}

async function main() {
  if (process.argv.includes("--healthcheck")) {
    await healthcheck();
    return;
  }
  const once = process.argv.includes("--once");
  const config = loadConfig();
  for (const directory of [
    config.dataRoot,
    config.jobsRoot,
    config.mirrorRoot,
    config.logsRoot,
  ]) {
    await fsp.mkdir(directory, { recursive: true });
  }
  await cleanupRetainedJobs(config);
  await cleanupRetainedLogs(config);
  const client = new GitHubClient(config);
  const state = new StateStore(config.stateFile);
  await state.load();
  const user = await client.currentUser();
  log("GitHub issue worker authenticated", `as ${user.login}`);
  await writeHeartbeat(config);
  const heartbeat = setInterval(() => {
    void writeHeartbeat(config).catch((error) =>
      log("Heartbeat update failed", safeError(error, config)),
    );
  }, 15_000);
  heartbeat.unref();
  await recoverStaleJobs(client, config);
  await bootstrapLabels(client, config);

  let pollFailures = 0;
  do {
    try {
      const issues = await client.searchByLabel(
        config.labels.ready,
        config.maxPerPoll,
      );
      await runLimited(issues, config.maxConcurrent, ({ repository, issue }) =>
        processIssue({
          client,
          config,
          state,
          tokenLogin: user.login,
          repository,
          searchIssue: issue,
        }),
      );
      await writeHeartbeat(config);
      pollFailures = 0;
    } catch (error) {
      pollFailures += 1;
      log("Polling failed", safeError(error, config));
      if (once || pollFailures >= config.maxPollFailures) throw error;
    }
    if (once || stopping) break;
    await waitForNextPoll(config.pollSeconds * 1000);
  } while (!stopping);
  clearInterval(heartbeat);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    stopping = true;
    wakePolling?.();
    for (const child of activeChildren) terminate(child);
  });
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
