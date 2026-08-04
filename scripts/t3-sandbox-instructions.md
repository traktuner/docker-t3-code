# Mandatory managed execution environment

This T3 deployment provides isolated, disposable coding environments through
the MCP server named `t3-sandbox`. Treat the T3 container as an orchestration
plane only. Local shell, filesystem, search, edit, package, build, test, and Git
tools are not a fallback execution environment.

For every repository task:

1. The first repository-related tool call MUST be either `sandbox_create` from
   the `t3-sandbox` MCP server or a `bash` tool whose description explicitly
   identifies it as the isolated T3 sandbox shell. OpenCode's sandbox-backed
   `bash` alias creates and reuses the sandbox automatically and never runs in
   the control container. Do this before reading, listing, searching, editing,
   checking Git, building, or testing. Do not try any other local tool first.
   Omit `workspace` unless the user explicitly selected another project; the
   MCP server defaults to the active project directory.
2. Use `profile=auto` so a repository `devcontainer.json` is used when it is
   present and accepted. Otherwise use the supplied agent base image.
3. Perform ALL filesystem inspection, edits, package installation, Git
   commands, builds, tests, media processing, and diagnostics through
   `sandbox_exec` using the returned sandbox ID or through the explicitly
   sandbox-backed `bash` alias. Repository changes persist through the mounted
   workspace.
4. Install missing task-specific tools inside the sandbox. Do not install them
   into the T3 container.
5. Use the `xcodebuild` MCP tools for Apple/Xcode operations. Linux sandboxes
   cannot replace the connected macOS Xcode worker.
6. Reuse the sandbox during one task, renew it for long work, and call
   `sandbox_destroy` when a disposable environment is no longer needed.
7. If sandbox creation or execution fails, report that infrastructure failure.
   Do not retry a blocked local tool. Use the sandbox-backed `bash` alias or the
   MCP tools instead; never fall back to local execution or local file mutation.
8. Repository safety rules still apply, including their approval boundaries.
   When the user explicitly authorizes commit, push, or a production deployment,
   perform it through the repository-approved workflow; do not incorrectly claim
   that this managed sandbox policy itself forbids an authorized operation.

Remote MCP servers may still be used for their intended external services.
Never expose model, provider, GitHub, or other host credentials inside a coding
sandbox unless the deployment explicitly provides a scoped credential.

## GitHub operations

Use the MCP server named `github` for GitHub issues, pull requests, repository
metadata, searches, reviews, and every explicitly authorized GitHub mutation.
The GitHub MCP runs in the trusted T3 control container and reuses its persisted
`t3-auth gh login`. Never run authenticated `gh` commands inside `t3-sandbox`:
sandbox workers intentionally receive no GitHub credential. If the `github` MCP
is unavailable, report the missing parent capability instead of copying or
requesting a token for the sandbox.

## SSH and Ansible deployments

For SSH and Ansible work from a sandbox, use the pre-provisioned Semaphore
deployment identity. Its private key is already available only inside the
sandbox at `/home/agent/.ssh/semaphore_ed25519`; `ANSIBLE_PRIVATE_KEY_FILE`
already points to it. Use the repository inventory (for example,
`ansible-playbook -i inventory/hosts.yml ...`) so host, user, port, and
host-key policy come from the declared inventory. Do not search for, generate,
copy, retrieve from Proton Pass, or try alternative SSH keys. In particular,
for `slvpdocker01`, use the inventory entry and this Semaphore identity rather
than trying an interactive `ssh` login or guessing an address, user, port, or
key path.
