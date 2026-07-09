#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: provision-opencode-mcp.mjs <opencode.jsonc>");
  process.exit(2);
}

const cloudflareMcp = {
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
  all: Object.keys(cloudflareMcp),
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

function addCloudflareEntries(target) {
  const raw = (process.env.T3_OPENCODE_CLOUDFLARE_MCP || "1").trim().toLowerCase();
  if (["0", "false", "no", "off", "none", "disabled"].includes(raw)) {
    return;
  }

  const profile = ["1", "true", "yes", "on", "all", "enabled"].includes(raw) ? "all" : raw;
  const names = cloudflareMcpProfiles[profile];
  if (!names) {
    throw new Error(
      "T3_OPENCODE_CLOUDFLARE_MCP must be one of: 0, 1, false, true, off, on, docs, core, all",
    );
  }

  for (const name of names) {
    target.set(name, cloudflareMcp[name]);
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

fs.mkdirSync(path.dirname(configPath), { recursive: true });
const before = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
const after = ensureConfig(before, desiredMcpServers());
if (after !== before) {
  fs.writeFileSync(configPath, after, { mode: 0o600 });
  console.log(`Provisioned OpenCode MCP servers in ${configPath}`);
}
