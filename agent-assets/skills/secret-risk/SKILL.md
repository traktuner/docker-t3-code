---
name: secret-risk
description: Detect secret exposure without reading or printing secret values - report path and category only. Load before commits touching config/env files, when a file looks credential-like, or on any suspicion of leaked secrets.
---

# Secret Risk Check — Detect Without Reading

Goal: find likely secret exposure while NEVER reading or printing a secret value.

## Detection (filename/pattern heuristics — do not open suspicious files to "check")

1. **Likely secret files** in the working tree / diff:
   `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `id_ed25519*`, `*kubeconfig*`, `credentials*`,
   `*.keystore`, `secrets.*`, `*token*` (filename-level match).
2. **Inline secrets in config** files: grep the DIFF (not the secret file itself) for key-shaped
   assignments: `apiKey`, `api_key`, `password`, `secret`, `token`, `Bearer `, `BEGIN.*PRIVATE KEY`
   — report the file+line, never echo the matched value.
3. **Anti-patterns to flag** (observed on this machine historically): API keys inline in tool
   config files; secrets pasted into harness permission allowlists. Both belong in `pass-cli`
   or env vars.

## Reporting rule (hard)

Report **path + category** only — e.g. "API key (inline) in a local harness config file".
NEVER the value, never a prefix of the value, never its length beyond "present".

Known accepted exception: an inline credential in a deliberate local-only config may be intentional.
Note it, do not "fix" it unasked.

## Using a secret without exposing it (pass-cli — the sanctioned way)

The user keeps secrets in Proton Pass. When a task NEEDS a credential (run a deploy, call an API,
fill a config), get the value into the PROCESS, never into your context / the model / the chat.
Reference format: `pass://<vault>/<item>/<field>`.

- **Run a command with secrets as env vars** (values stay in the subprocess; pass-cli MASKS them in
  stdout/stderr by default):
  `export API_KEY="pass://MyVault/service/password"` then `pass-cli run -- ./deploy.sh`
  or with a dotenv file of `pass://` refs: `pass-cli run --env-file .env -- <cmd>`.
- **Fill a config/template file** (never prints the value; output file is 0600):
  `pass-cli inject -i config.tpl -o config.yaml`  (template contains `pass://...` references).
- **NEVER** `pass-cli item view` / `totp` to read a secret's VALUE into the chat — that surfaces it
  to the model (the model may use an external endpoint). Values belong in subprocess env or injected files only.
- Non-interactive auth uses a scoped **agent token** the USER generates (vault-scoped, expiring,
  audited via `PROTON_PASS_AGENT_REASON`). You never create, read, or print that token.

If a task seems to require the raw secret value in your reasoning, stop and ask the user — it almost
never does; it needs the secret's LOCATION (`pass://...`), which `run`/`inject` resolve for you.

## Delegation rule (hard)

Never pass secret contents into ANY delegated prompt or external service. If a task seems to need a secret value, stop and ask
the user; usually the task needs the secret's LOCATION or an env-var reference, not the value.

## If a secret is found where it should not be

1. Report path + category + why it is exposed (committed? world-readable? in a public repo?).
2. Recommend: move to `pass-cli`/env; rotate if it was ever committed or published.
3. Do not delete/rewrite history on your own — that is a user decision.
