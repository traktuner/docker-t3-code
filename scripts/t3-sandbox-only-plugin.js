const blockedLocalTools = new Set([
  "apply_patch",
  "bash",
  "edit",
  "glob",
  "grep",
  "list",
  "multiedit",
  "patch",
  "read",
  "task",
  "write",
]);

export const T3SandboxOnly = async () => ({
  "tool.execute.before": async (input) => {
    if (!blockedLocalTools.has(input.tool)) return;
    throw new Error(
      `Local tool '${input.tool}' is disabled. Use the t3-sandbox MCP tools for repository work.`,
    );
  },
});
