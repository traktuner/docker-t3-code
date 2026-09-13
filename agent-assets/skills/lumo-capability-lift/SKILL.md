---
name: lumo-capability-lift
description: Recovery and quality patterns for difficult Lumo Max/Lite work. Load when reasoning is hard, output is malformed or truncated, a tool/implementation failed repeatedly, structured data needs validation, or independent alternatives are needed.
---

# Lumo Capability Lift

Use only the pattern matching the observed failure. `lumo-max` is a Proton routing tier, not proof
of one fixed backend model; trust measured provider behavior and repository evidence.

## 1. Re-ground and re-plan

When work drifts or a premise fails, read the governing source/tests again. Update the plan or todos
only when that improves orientation; neither is a keepalive mechanism.

## 2. Architect/editor split

Use when planning and mechanical edits are cleanly separable. The planner writes a precise plan;
a suitable editor worker executes it; the planner reads the real diff. A plan/reality mismatch returns
to the planner instead of inviting a cheaper tier to improvise. Two failed editor plans require a
stronger implementation route.

## 3. Structured output recovery

Direct Lumo API `json_object`/`json_schema` responses work empirically, but strictness is not a
contract. A client may represent structured output as a required tool call, while Lumo ignores
`tool_choice`. Always parse and validate client-side. On failure: extract one JSON-like block, validate
required keys, then retry once with the schema and one concrete example. Never accept XML-ish or
partially parsed output as success.

## 4. Independent alternatives

For a hard judgment without an executable oracle, use three independent voter sessions and judge
their evidence, including dissent. For implementation, do not create competing versions directly in
one shared working tree. Generate alternatives only in separate worktrees/directories or as bounded
read-only proposals, run the same checks, then integrate one winner.

## 5. Multi-angle research

For cross-codebase or external research, use 2-3 disjoint retrieval angles. Cite file:line or primary
sources, list contradictions, and resolve disputed claims by reading the exact source. More searches
without a distinct angle are duplication, not confidence. Several versions, mirrors, or pages from
the same publisher/documentation family count as one provenance; independent confirmation requires
a genuinely separate origin. Explicitly requested retrieval methods that were skipped remain
limitations.

## 6. Output and tool discipline

Lumo honors `max_tokens` in the current JSON and SSE probes. `tool_choice` is not a reliable
suppression mechanism in this endpoint, so suppress tools in the client when required. Independent
tool calls may run concurrently; dependent calls remain ordered. A failed call is never repeated
unchanged: inspect the exact error, change one precondition or approach, and after two failures
re-ground or escalate. Malformed/empty delegated output gets one smaller retry.

## 7. Grounded review

Reread the full diff and identify the most likely missed caller, edge case, or stale assumption. Then
prove it with tools: run focused checks, verify referenced dynamic symbols/assets/config keys exist,
and name runtime paths the checks did not exercise. Introspection alone is not evidence. Before
declaring success, reconcile the user's acceptance criteria and every reported metric with the final
raw outputs. Preserve the verifier's units: runner tests/suites, inline assertions/cases, files, and
manual checks are distinct. UI visibility requires UI evidence, not merely emitted backend events.

## 8. Performance work

Measure a baseline first: metric, current value, target. Rank hypotheses by impact x confidence /
effort, apply one change, re-measure, and stop once the target is met. Every number is labeled measured
or estimated. Never smuggle data loss, caps, or semantic changes into an optimization.

## 9. Long work

Use todos for durable orientation and an independent review for long reviews. If a step budget becomes
tight, return an honest handoff with completed evidence and the exact next action.

## Symptom map

| Symptom | Pattern |
|---|---|
| Drift or wrong premise | 1 |
| Large mechanical edit | 2 |
| Malformed JSON/tool syntax | 3 + 6 |
| Hard architecture judgment | 4 |
| Thin research result | 5 |
| Repeated tool failure | 6 |
| Plausible but unproven code | 7 |
| Performance claim | 8 |
| Long task orientation | 9 |
