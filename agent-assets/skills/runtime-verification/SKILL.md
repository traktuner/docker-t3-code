---
name: runtime-verification
description: Verify a code, configuration, UI, CLI, API, agent-prompt, or analysis change through its real public runtime or evidence surface. Use after non-trivial implementation when tests/builds cannot prove the user-visible behavior, when a bug fix needs reproduction, when UI or integration behavior is claimed, or when a consequential analysis conclusion needs a direct falsification probe.
---

# Runtime Verification

Verify the claim where a real user or consumer meets it. Tests, typechecks, builds, source inspection,
and reviewer opinion support the work but do not replace this observation.

## 1. Pin the claim

State the exact behavior being verified and the relevant final diff or analysis conclusion. If the
description and actual change disagree, report that before continuing.

## 2. Choose the surface

- CLI or TUI: run the public command and capture its output.
- API or server: launch the real service and send a request through its public route.
- GUI: drive the affected flow and inspect pixels or a screenshot.
- Library: use the documented package export, not an internal function.
- Agent prompt or plugin: run a fresh agent/session through the real harness and capture its events
  and final behavior.
- Investigation or research: rerun the decisive query against the authoritative source/log and test
  the cheapest plausible counterexample.

If the surface is destructive or externally consequential and no safe target/dry-run exists, do not
exercise it. Mark that path unverified.

## 3. Drive and challenge it

Run the smallest happy path that reaches the changed behavior. Then run at least one relevant
falsification probe: malformed input, stale state, a repeated action, an adjacent error, conflicting
evidence, or another case the change could have missed. Diagnose unexpected output instead of
explaining it away.

## 4. Capture evidence

Keep the raw command output, response, screenshot, event trace, or primary-source excerpt needed to
support the verdict. Preserve the producer's units and names. Do not turn a build into runtime proof,
backend events into UI proof, or several manual assertions into several runner tests.

## 5. Report

Return:

- `Verdict: PASS | FAIL | BLOCKED | SKIP`
- Claim and exercised surface
- Observed happy path and falsification probe
- Exact evidence
- Unexercised runtime paths or contradictory evidence

`PASS` requires direct observation at the chosen surface. `BLOCKED` identifies the precise missing
environment, permission, service, device, or safe target. `SKIP` is only for a change or conclusion
with no meaningful runtime/evidence surface.
