---
name: asd-ste100
description: Apply ASD-STE100-inspired rules to operational English. Use silent writing mode by default. Use audit mode only for an explicit STE audit, Simplification Review, comparison, or STE rewrite.
---

# ASD-STE100 operational writing

Use this overlay with the pinned upstream material in `upstream/`.

Read `upstream/references/writing-rules.md` when you need the detailed rules.
Read `upstream/examples/before-after.md` when the user explicitly requests an audit or rewrite.
The upstream source and license are in `upstream/README.md` and `upstream/LICENSE`.

## Mode 1: silent writing mode

This mode is the default.

Apply the mandatory ASD-STE100 rules to operational English prose. Preserve every fact, number, condition, exception, safety constraint, and scope statement. Keep code, identifiers, commands, data, protocol fields, logs, third-party errors, and quotations unchanged. Do not translate German text. Do not show rule analysis or a before-and-after table.

## Mode 2: explicit audit mode

Use this mode only when the user explicitly requests one of these outputs:

- an STE audit;
- an ASD-STE100 audit;
- a Simplification Review;
- a before-and-after comparison;
- a rewrite of existing text under STE rules.

Identify applicable rule violations. Then provide a concise before-and-after table. Explain material changes. Preserve code, logs, quotations, facts, conditions, numbers, exceptions, and scope.

## Priority

Technical precision and safety take priority over sentence-length targets. Do not simplify a technical term when the change can alter its meaning.
