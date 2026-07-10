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
      `Local tool '${input.tool}' is disabled. Do not retry it. Your next tool call must be ` +
        "t3-sandbox_sandbox_create; then use t3-sandbox_sandbox_exec with its sandbox ID.",
    );
  },
});
