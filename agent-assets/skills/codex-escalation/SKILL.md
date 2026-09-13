---
name: codex-escalation
description: Rules and procedure for escalating from Lumo Max to gpt-5.6-luna at max reasoning (subscription quota, rationed). Load whenever considering a Codex escalation or when the quota band is unclear.
---

# Codex Escalation — Rationed Frontier Access

The Codex rescue tier is `gpt-5.6-luna` with `max` reasoning and it is RATIONED by the live
subscription limits. Every spend must earn its slot; do not assume a fixed number of tasks per day.

## When escalation is justified (need BOTH)

1. **Category fits:** critical adversarial review (security, architecture, high blast radius) ·
   architecture judgment call · implementation rescue with failure evidence.
2. **Lumo came first:** an independent review already ran / the standard implementation already failed,
   and you can state what was tried and why it was insufficient. Exception: explicit user request.

Routine work NEVER goes to Codex. A weak reason today deletes a strong option tomorrow.

## The only sanctioned path: the approved Codex escalation entry point

Do not bypass the registered Codex escalation path with an ad hoc CLI invocation. The approved path:
- checks the quota first via `codex-quota` (token-free, both rate windows),
- pins `gpt-5.6-luna` with `max` reasoning,
- pins the sandbox by mode: `review` → read-only, `implement` → workspace-write,
- rejects briefs under 200 characters (underspecified briefs waste rationed runs).

## Quota bands (PLAN-AWARE, gate on max(primary, secondary) usedPercent)

The same usedPercent means different things per plan — the user's subscription changes over time
(sometimes Pro, sometimes Free), so the tool reads `planType` from the RPC and applies:

| Plan class | green | warn (user confirm) | deny |
|---|---|---|---|
| pro / prolite / team / business / enterprise | < 90 | 90-97 | > 97 |
| plus / go | < 80 | 80-93 | > 93 |
| free / unknown | < 75 | 75-90 | > 90 |

Modifiers: `unlimited` credits → green. An available **reset credit** softens deny → warn
(redeeming a weekly-limit reset is the USER's decision — never consume it programmatically).
A reported `rateLimitReachedType` forces deny (or warn if a reset credit is available).

Note: the SECONDARY window is weekly — it exhausts silently while the 5h primary looks empty.
Always report both, and always name the plan the decision was based on.

## One task = one complete brief

Codex gets NO budgeted follow-up turns. The brief must be self-contained:
goal · constraints · exact file paths · the diff or code (pasted) · what Lumo tried and why it
failed (for rescues) · expected output format. If you cannot write that brief, you are not ready
to spend.

## Fallback when denied/exhausted

`/vote` with voters at Plus level (poor man's frontier) for judgment calls; decomposed `/impl`
retry for implementation. Always tell the user when the budget resets.

## After every Codex run

The result is an UNTRUSTED PROPOSAL: verify claims against the code; for implement-mode runs,
`git status --short` + `git diff --stat` + full diff review + guardrails (diff-size, dependencies).
Report cost posture: one gated Luna run spent, current band, reset time.
