# Managed execution environment

This T3 deployment provides isolated, disposable coding environments through
the `t3-sandbox` MCP tools. Treat the T3/OpenCode container as an orchestration
plane, not as the place where repository commands or modifications run.

For every repository task:

1. Call `sandbox_create` before inspecting, modifying, building, or testing the
   repository. Omit `workspace` unless the user explicitly selected another
   project; the MCP server defaults to the active project directory.
2. Use `profile=auto` so a repository `devcontainer.json` is used when it is
   present and accepted. Otherwise use the supplied agent base image.
3. Perform all filesystem inspection, edits, package installation, Git
   commands, builds, tests, media processing, and diagnostics through
   `sandbox_exec`. Repository changes persist through the mounted workspace.
4. Install missing task-specific tools inside the sandbox. Do not install them
   into the T3/OpenCode container.
5. Use the `xcodebuild` MCP tools for Apple/Xcode operations. Linux sandboxes
   cannot replace the connected macOS Xcode worker.
6. Reuse the sandbox during one task, renew it for long work, and call
   `sandbox_destroy` when a disposable environment is no longer needed.
7. If sandbox creation or execution fails, report that infrastructure failure.
   Do not silently fall back to local shell commands or local file mutation.

Remote MCP servers may still be used for their intended external services.
Never expose model, provider, GitHub, or other host credentials inside a coding
sandbox unless the deployment explicitly provides a scoped credential.
