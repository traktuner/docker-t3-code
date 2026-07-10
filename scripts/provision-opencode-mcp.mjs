#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: provision-opencode-mcp.mjs <opencode.jsonc>");
  process.exit(2);
}
const reconcileManaged = (process.env.T3_SANDBOX_MCP_RECONCILE || "1") === "1";
const managedMcpNames = ["t3-sandbox", "xcodebuild"];
const sandboxInstructionsFile = (
  process.env.T3_OPENCODE_SANDBOX_INSTRUCTIONS_FILE || ""
).trim();
const sandboxOnly = /^(?:1|true|yes|on)$/i.test(
  process.env.T3_OPENCODE_SANDBOX_ONLY || "",
);

const cloudflareMcpBase = {
  cloudflare: {
    type: "remote",
    url: "https://mcp.cloudflare.com/mcp",
    enabled: true,
    oauth: {},
  },
  "cloudflare-docs": {
    type: "remote",
    url: "https://docs.mcp.cloudflare.com/mcp",
    enabled: true,
  },
  "cloudflare-bindings": {
    type: "remote",
    url: "https://bindings.mcp.cloudflare.com/mcp",
    enabled: true,
    oauth: {},
  },
  "cloudflare-builds": {
    type: "remote",
    url: "https://builds.mcp.cloudflare.com/mcp",
    enabled: true,
    oauth: {},
  },
  "cloudflare-observability": {
    type: "remote",
    url: "https://observability.mcp.cloudflare.com/mcp",
    enabled: true,
    oauth: {},
  },
};

const cloudflareMcpProfiles = {
  docs: ["cloudflare-docs"],
  core: ["cloudflare", "cloudflare-docs"],
  api: ["cloudflare", "cloudflare-docs"],
  token: ["cloudflare", "cloudflare-docs"],
  all: Object.keys(cloudflareMcpBase),
};

const mcpPresets = {
  grep: {
    gh_grep: {
      type: "remote",
      url: "https://mcp.grep.app",
      enabled: true,
      timeout: 10000,
    },
  },
};

function parseMcpServers(label, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }

  const servers = parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.mcp
    ? parsed.mcp
    : parsed;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`${label} must be an object of OpenCode MCP server definitions`);
  }

  for (const [name, config] of Object.entries(servers)) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`${label}.${name} must be an object`);
    }
  }
  return servers;
}

const rawEntryMarker = Symbol("rawMcpEntry");

function addObjectEntries(target, entries) {
  for (const [name, config] of Object.entries(entries)) {
    target.set(name, config);
  }
}

function addMissingEntries(target, entries) {
  for (const [name, config] of Object.entries(entries)) {
    if (!target.has(name)) target.set(name, config);
  }
}

function firstNonEmptyEnv(names) {
  for (const name of names) {
    if ((process.env[name] || "").trim()) return name;
  }
  return "";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloudflareAuthMode() {
  const raw = (process.env.T3_OPENCODE_CLOUDFLARE_AUTH || "auto").trim().toLowerCase();
  if (!["auto", "oauth", "token"].includes(raw)) {
    throw new Error("T3_OPENCODE_CLOUDFLARE_AUTH must be one of: auto, oauth, token");
  }
  if (raw !== "auto") return raw;
  return firstNonEmptyEnv(["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"]) ? "token" : "oauth";
}

function cloudflareEntry(name, authMode = cloudflareAuthMode()) {
  const entry = cloneJson(cloudflareMcpBase[name]);
  const tokenEnv = firstNonEmptyEnv(["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"]);
  if (name === "cloudflare" && authMode === "token") {
    if (!tokenEnv) {
      throw new Error("T3_OPENCODE_CLOUDFLARE_AUTH=token requires CLOUDFLARE_API_TOKEN or CF_API_TOKEN");
    }
    entry.oauth = false;
    entry.headers = {
      ...(entry.headers || {}),
      Authorization: `Bearer {env:${tokenEnv}}`,
    };
  }
  return entry;
}

function addCloudflareEntries(target) {
  const raw = (process.env.T3_OPENCODE_CLOUDFLARE_MCP || "1").trim().toLowerCase();
  if (["0", "false", "no", "off", "none", "disabled"].includes(raw)) {
    return;
  }

  const profile = ["1", "true", "yes", "on", "enabled"].includes(raw) ? "core" : raw;
  const names = cloudflareMcpProfiles[profile];
  if (!names) {
    throw new Error(
      "T3_OPENCODE_CLOUDFLARE_MCP must be one of: 0, 1, false, true, off, on, docs, core, api, token, all",
    );
  }

  const authMode = profile === "token" ? "token" : cloudflareAuthMode();
  for (const name of names) {
    if (!target.has(name)) target.set(name, cloudflareEntry(name, authMode));
  }
}

function context7Preset() {
  const entry = {
    type: "remote",
    url: "https://mcp.context7.com/mcp",
    enabled: true,
    timeout: 10000,
  };
  if (firstNonEmptyEnv(["CONTEXT7_API_KEY"])) {
    entry.headers = { CONTEXT7_API_KEY: "{env:CONTEXT7_API_KEY}" };
  }
  return { context7: entry };
}

function githubPreset() {
  const tokenEnv = firstNonEmptyEnv(["GITHUB_PERSONAL_ACCESS_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]);
  if (!tokenEnv) return {};
  return {
    github: {
      type: "remote",
      url: "https://api.githubcopilot.com/mcp/",
      enabled: true,
      oauth: false,
      headers: {
        Authorization: `Bearer {env:${tokenEnv}}`,
      },
      timeout: 10000,
    },
  };
}

function sentryPreset() {
  const tokenEnv = firstNonEmptyEnv(["SENTRY_ACCESS_TOKEN", "SENTRY_AUTH_TOKEN"]);
  if (tokenEnv) {
    return {
      sentry: {
        type: "local",
        command: ["npx", "-y", "@sentry/mcp-server@latest"],
        environment: {
          SENTRY_ACCESS_TOKEN: `{env:${tokenEnv}}`,
        },
        enabled: true,
        timeout: 10000,
      },
    };
  }
  return {
    sentry: {
      type: "remote",
      url: "https://mcp.sentry.dev/mcp",
      enabled: true,
      oauth: {},
      timeout: 10000,
    },
  };
}

function sandboxPreset() {
  if (!firstNonEmptyEnv(["T3_SANDBOX_URL"]) || !firstNonEmptyEnv(["T3_SANDBOX_TOKEN"])) {
    return {};
  }
  return {
    "t3-sandbox": {
      type: "local",
      command: ["t3-sandbox-mcp"],
      environment: {
        T3_SANDBOX_URL: "{env:T3_SANDBOX_URL}",
        T3_SANDBOX_TOKEN: "{env:T3_SANDBOX_TOKEN}",
      },
      enabled: true,
      timeout: 3700000,
    },
  };
}

function xcodePreset() {
  if (
    !firstNonEmptyEnv(["T3_XCODE_SSH_HOST"]) ||
    !firstNonEmptyEnv(["T3_XCODE_REMOTE_WORKSPACE_ROOT"])
  ) {
    return {};
  }
  return {
    xcodebuild: {
      type: "local",
      command: ["t3-xcode-mcp"],
      enabled: true,
      timeout: 3700000,
    },
  };
}

function addPresetEntries(target) {
  const raw = (process.env.T3_OPENCODE_MCP_PRESETS || "").trim();
  if (!raw) return;

  const presetNames = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (presetNames.includes("none") || presetNames.includes("off") || presetNames.includes("0")) {
    return;
  }

  for (const name of presetNames) {
    if (name === "context7") {
      addMissingEntries(target, context7Preset());
      continue;
    }
    if (name === "github") {
      addMissingEntries(target, githubPreset());
      continue;
    }
    if (name === "sentry") {
      addMissingEntries(target, sentryPreset());
      continue;
    }
    const preset = mcpPresets[name];
    if (!preset) {
      throw new Error(`Unknown T3_OPENCODE_MCP_PRESETS entry: ${name}`);
    }
    addMissingEntries(target, preset);
  }
}

function readJsonLikeValueEnd(input, valueStart, objectEnd) {
  if (input[valueStart] === "{" || input[valueStart] === "[") {
    const valueEnd = findMatchingClose(input, valueStart);
    if (valueEnd < 0) return -1;
    return valueEnd;
  }
  if (input[valueStart] === '"') {
    const valueString = readString(input, valueStart);
    return valueString ? valueString.end - 1 : -1;
  }

  let valueEnd = valueStart;
  while (valueEnd < objectEnd && input[valueEnd] !== "," && input[valueEnd] !== "\n") {
    valueEnd += 1;
  }
  return valueEnd - 1;
}

function collectMcpEntries(input, configLabel) {
  const entries = new Map();
  const text = input.trim().length === 0 ? "{}\n" : input;
  const rootStart = text.indexOf("{");
  if (rootStart < 0) throw new Error(`${configLabel} does not contain a JSON object`);
  const rootEnd = findMatchingBrace(text, rootStart);
  if (rootEnd < 0) throw new Error(`${configLabel} has an unterminated root object`);
  const mcpProperty = findObjectProperty(text, rootStart, rootEnd, "mcp");
  if (!mcpProperty) return entries;
  if (text[mcpProperty.valueStart] !== "{") {
    throw new Error(`${configLabel} has an mcp property, but it is not an object`);
  }

  let i = mcpProperty.valueStart + 1;
  while (i < mcpProperty.valueEnd) {
    i = skipSpaceAndComments(text, i);
    if (i >= mcpProperty.valueEnd || text[i] === "}") break;
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    const key = readString(text, i);
    if (!key) {
      i += 1;
      continue;
    }
    const colon = skipSpaceAndComments(text, key.end);
    if (text[colon] !== ":") {
      i = key.end;
      continue;
    }
    const valueStart = skipSpaceAndComments(text, colon + 1);
    const valueEnd = readJsonLikeValueEnd(text, valueStart, mcpProperty.valueEnd);
    if (valueEnd < valueStart) throw new Error(`${configLabel}.${key.value} has an invalid value`);
    entries.set(key.value, { [rawEntryMarker]: text.slice(valueStart, valueEnd + 1).trim() });
    i = valueEnd + 1;
  }
  return entries;
}

function desiredMcpServers() {
  const desired = new Map();

  const preserveFile = process.env.T3_OPENCODE_MCP_PRESERVE_FILE || "";
  if (preserveFile && fs.existsSync(preserveFile)) {
    try {
      for (const [name, config] of collectMcpEntries(
        fs.readFileSync(preserveFile, "utf8"),
        `T3_OPENCODE_MCP_PRESERVE_FILE (${preserveFile})`,
      )) {
        desired.set(name, config);
      }
    } catch (error) {
      console.warn(`Warning: could not preserve existing OpenCode MCP entries: ${error.message}`);
    }
  }

  addCloudflareEntries(desired);
  addPresetEntries(desired);
  if (reconcileManaged) {
    for (const name of managedMcpNames) desired.delete(name);
    addObjectEntries(desired, sandboxPreset());
    addObjectEntries(desired, xcodePreset());
  } else {
    addMissingEntries(desired, sandboxPreset());
    addMissingEntries(desired, xcodePreset());
  }

  const extraFile = process.env.T3_OPENCODE_MCP_SERVERS_FILE || "";
  if (extraFile) {
    addObjectEntries(
      desired,
      parseMcpServers(`T3_OPENCODE_MCP_SERVERS_FILE (${extraFile})`, fs.readFileSync(extraFile, "utf8")),
    );
  }

  const extraJson = process.env.T3_OPENCODE_MCP_SERVERS_JSON || process.env.T3_OPENCODE_MCP_JSON || "";
  if (extraJson.trim()) {
    addObjectEntries(desired, parseMcpServers("T3_OPENCODE_MCP_SERVERS_JSON", extraJson));
  }

  return desired;
}

function skipSpaceAndComments(input, index) {
  let i = index;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

function readString(input, index) {
  if (input[index] !== '"') return null;
  let i = index + 1;
  let value = "";
  while (i < input.length) {
    const c = input[i];
    if (c === "\\") {
      value += input.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '"') {
      try {
        value = JSON.parse(input.slice(index, i + 1));
      } catch {
        return null;
      }
      return { value, end: i + 1 };
    }
    value += c;
    i += 1;
  }
  return null;
}

function findMatchingClose(input, openIndex) {
  const open = input[openIndex];
  const close = open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return -1;

  let depth = 0;
  let i = openIndex;
  while (i < input.length) {
    const c = input[i];
    if (c === '"') {
      const str = readString(input, i);
      if (!str) return -1;
      i = str.end;
      continue;
    }
    if (c === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === open) depth += 1;
    if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function findMatchingBrace(input, openIndex) {
  return findMatchingClose(input, openIndex);
}

function findObjectProperty(input, objectStart, objectEnd, propertyName) {
  let i = objectStart + 1;
  while (i < objectEnd) {
    i = skipSpaceAndComments(input, i);
    if (i >= objectEnd || input[i] === "}") return null;
    if (input[i] === ",") {
      i += 1;
      continue;
    }
    const key = readString(input, i);
    if (!key) {
      i += 1;
      continue;
    }
    let colon = skipSpaceAndComments(input, key.end);
    if (input[colon] !== ":") {
      i = key.end;
      continue;
    }
    const valueStart = skipSpaceAndComments(input, colon + 1);
    const valueEnd = readJsonLikeValueEnd(input, valueStart, objectEnd);
    if (valueEnd < valueStart) return null;
    if (key.value === propertyName) {
      return { keyStart: i, keyEnd: key.end, valueStart, valueEnd };
    }
    i = valueEnd + 1;
  }
  return null;
}

function lineIndent(input, index) {
  const lineStart = input.lastIndexOf("\n", index) + 1;
  const match = /^[ \t]*/.exec(input.slice(lineStart, index));
  return match ? match[0] : "";
}

function renderEntryValue(value) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value[rawEntryMarker] === "string"
  ) {
    return value[rawEntryMarker];
  }
  return JSON.stringify(value);
}

function insertRootProperty(input, name, renderedValue) {
  const rootStart = input.indexOf("{");
  if (rootStart < 0) throw new Error(`${configPath} does not contain a JSON object`);
  const rootEnd = findMatchingBrace(input, rootStart);
  if (rootEnd < 0) throw new Error(`${configPath} has an unterminated root object`);
  const rootIndent = lineIndent(input, rootEnd);
  const propertyIndent = `${rootIndent}  `;
  const beforeClose = input.slice(rootStart + 1, rootEnd).trimEnd();
  const needsComma = beforeClose.length > 0 && !beforeClose.endsWith(",");
  const insert = `${needsComma ? "," : ""}\n${propertyIndent}${JSON.stringify(name)}: ${renderedValue}\n`;
  return `${input.slice(0, rootEnd)}${insert}${input.slice(rootEnd)}`;
}

function ensureArrayString(input, propertyName, value) {
  if (!value) return input;
  const rootStart = input.indexOf("{");
  const rootEnd = rootStart >= 0 ? findMatchingBrace(input, rootStart) : -1;
  if (rootEnd < 0) throw new Error(`${configPath} has an invalid root object`);
  const property = findObjectProperty(input, rootStart, rootEnd, propertyName);
  if (!property) {
    return insertRootProperty(input, propertyName, `[${JSON.stringify(value)}]`);
  }
  if (input[property.valueStart] !== "[") {
    throw new Error(`${configPath} has a ${propertyName} property, but it is not an array`);
  }

  let cursor = property.valueStart + 1;
  while (cursor < property.valueEnd) {
    cursor = skipSpaceAndComments(input, cursor);
    if (input[cursor] === ",") {
      cursor += 1;
      continue;
    }
    const item = readString(input, cursor);
    if (!item) {
      cursor += 1;
      continue;
    }
    if (item.value === value) return input;
    cursor = item.end;
  }

  const beforeClose = input.slice(property.valueStart + 1, property.valueEnd).trimEnd();
  const needsComma = beforeClose.length > 0 && !beforeClose.endsWith(",");
  const insert = `${needsComma ? "," : ""}\n    ${JSON.stringify(value)}\n  `;
  return `${input.slice(0, property.valueEnd)}${insert}${input.slice(property.valueEnd)}`;
}

function upsertObjectEntries(input, propertyName, desiredEntries) {
  if (desiredEntries.size === 0) return input;
  let rootStart = input.indexOf("{");
  let rootEnd = rootStart >= 0 ? findMatchingBrace(input, rootStart) : -1;
  if (rootEnd < 0) throw new Error(`${configPath} has an invalid root object`);
  let property = findObjectProperty(input, rootStart, rootEnd, propertyName);
  if (!property) {
    const rendered = `{\n${entryLines([...desiredEntries], "    ")}\n  }`;
    return insertRootProperty(input, propertyName, rendered);
  }
  if (input[property.valueStart] !== "{") {
    throw new Error(`${configPath} has a ${propertyName} property, but it is not an object`);
  }

  const replacements = [...desiredEntries].flatMap(([name, value]) => {
    const entry = findObjectProperty(input, property.valueStart, property.valueEnd, name);
    return entry ? [{ ...entry, value: renderEntryValue(value) }] : [];
  });
  let output = replacements
    .sort((left, right) => right.valueStart - left.valueStart)
    .reduce(
      (text, replacement) =>
        `${text.slice(0, replacement.valueStart)}${replacement.value}${text.slice(replacement.valueEnd + 1)}`,
      input,
    );

  rootStart = output.indexOf("{");
  rootEnd = findMatchingBrace(output, rootStart);
  property = findObjectProperty(output, rootStart, rootEnd, propertyName);
  const missing = [...desiredEntries].filter(
    ([name]) => !findObjectProperty(output, property.valueStart, property.valueEnd, name),
  );
  if (missing.length === 0) return output;
  const indent = `${lineIndent(output, property.valueEnd)}  `;
  const beforeClose = output.slice(property.valueStart + 1, property.valueEnd).trimEnd();
  const needsComma = beforeClose.length > 0 && !beforeClose.endsWith(",");
  const insert = `${needsComma ? "," : ""}\n${entryLines(missing, indent)}\n${lineIndent(output, property.valueEnd)}`;
  return `${output.slice(0, property.valueEnd)}${insert}${output.slice(property.valueEnd)}`;
}

function entryLines(entries, indent) {
  return entries
    .map(([name, config]) => `${indent}${JSON.stringify(name)}: ${renderEntryValue(config)}`)
    .join(",\n");
}

function ensureConfig(input, mcpServers) {
  let text = input.trim().length === 0 ? "{}\n" : input;
  const entries = [...mcpServers.entries()];
  if (entries.length === 0) return text;

  const rootStart = text.indexOf("{");
  if (rootStart < 0) throw new Error(`${configPath} does not contain a JSON object`);
  const rootEnd = findMatchingBrace(text, rootStart);
  if (rootEnd < 0) throw new Error(`${configPath} has an unterminated root object`);

  const mcpProperty = findObjectProperty(text, rootStart, rootEnd, "mcp");
  if (mcpProperty && text[mcpProperty.valueStart] !== "{") {
    throw new Error(`${configPath} has an mcp property, but it is not an object`);
  }

  if (!mcpProperty) {
    const rootIndent = lineIndent(text, rootEnd);
    const mcpIndent = `${rootIndent}  `;
    const entryIndent = `${mcpIndent}  `;
    const beforeClose = text.slice(rootStart + 1, rootEnd).trimEnd();
    const needsComma = beforeClose.length > 0 && !beforeClose.endsWith(",");
    const insert =
      `${needsComma ? "," : ""}\n${mcpIndent}"mcp": {\n` +
      `${entryLines(entries, entryIndent)}\n${mcpIndent}}\n`;
    return `${text.slice(0, rootEnd)}${insert}${text.slice(rootEnd)}`;
  }

  const mcpStart = mcpProperty.valueStart;
  const mcpEnd = mcpProperty.valueEnd;
  const missing = entries.filter(([name]) => !findObjectProperty(text, mcpStart, mcpEnd, name));
  if (missing.length === 0) return text;

  const mcpIndent = lineIndent(text, mcpEnd);
  const entryIndent = `${mcpIndent}  `;
  const beforeClose = text.slice(mcpStart + 1, mcpEnd).trimEnd();
  const needsComma = beforeClose.length > 0 && !beforeClose.endsWith(",");
  const insert = `${needsComma ? "," : ""}\n${entryLines(missing, entryIndent)}\n${mcpIndent}`;
  return `${text.slice(0, mcpEnd)}${insert}${text.slice(mcpEnd)}`;
}

function reconcileManagedEntries(input, desired) {
  if (!reconcileManaged || input.trim().length === 0) return input;
  const rootStart = input.indexOf("{");
  if (rootStart < 0) return input;
  const rootEnd = findMatchingBrace(input, rootStart);
  if (rootEnd < 0) return input;
  const mcpProperty = findObjectProperty(input, rootStart, rootEnd, "mcp");
  if (!mcpProperty || input[mcpProperty.valueStart] !== "{") return input;

  const replacements = managedMcpNames.flatMap((name) => {
    const property = findObjectProperty(
      input,
      mcpProperty.valueStart,
      mcpProperty.valueEnd,
      name,
    );
    if (!property) return [];
    const value = desired.get(name) || {
      type: "local",
      command: [name === "t3-sandbox" ? "t3-sandbox-mcp" : "t3-xcode-mcp"],
      enabled: false,
    };
    return [{ ...property, value: renderEntryValue(value) }];
  });
  return replacements
    .sort((left, right) => right.valueStart - left.valueStart)
    .reduce(
      (text, replacement) =>
        `${text.slice(0, replacement.valueStart)}${replacement.value}${text.slice(replacement.valueEnd + 1)}`,
      input,
    );
}

fs.mkdirSync(path.dirname(configPath), { recursive: true });
const before = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
const desired = desiredMcpServers();
let after = ensureConfig(reconcileManagedEntries(before, desired), desired);
after = ensureArrayString(after, "instructions", sandboxInstructionsFile);
if (sandboxOnly) {
  after = upsertObjectEntries(
    after,
    "permission",
    new Map([
      ["bash", "deny"],
      ["edit", "deny"],
      ["write", "deny"],
      ["patch", "deny"],
      ["read", "deny"],
      ["glob", "deny"],
      ["grep", "deny"],
      ["list", "deny"],
      ["external_directory", "deny"],
      [
        "task",
        {
          "*": "deny",
          "researcher-basic": "allow",
          "editor-basic": "allow",
          "implementer-plus": "allow",
          "reviewer-plus": "allow",
          "voter-basic": "allow",
          explore: "allow",
          general: "allow",
        },
      ],
      ["t3-sandbox_*", "allow"],
      ["xcodebuild_*", "allow"],
    ]),
  );
}
if (after !== before) {
  const temporary = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, after, { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  console.log(`Provisioned OpenCode MCP servers in ${configPath}`);
}
