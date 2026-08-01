---
horizon: m
id: 4027
title: "ESLint frontier: ir/from-ast 'concrete return needs a dynamic box' aborts the compile"
status: ready
created: 2026-08-01
updated: 2026-08-01
assignee: unassigned
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, ir
language_feature: type-mapping
goal: npm-library-support
sprint: current
required_by: [1282, 1400, 2693]
es_edition: n/a
related: [1282, 2855, 3672, 4001, 4018, 4019]
---

# #4027 — `concrete return needs a dynamic box in getPlaceholderMatcher`

## Problem

One of the two hard errors now blocking the ESLint `linter.js` graph, reachable
only after #4001, #4018 and #4019:

```text
Codegen error: IR path failed for getPlaceholderMatcher:
ir/from-ast: concrete return needs a dynamic box in getPlaceholderMatcher
[IR-FALLBACK]
```

## Why it is FATAL rather than a fallback

The `[IR-FALLBACK]` suffix is misleading. `formatIrPathFallbackDiagnostic`
(`src/codegen/index.ts`) classifies a failure as **hard** when
`err.outcome.kind === "invariant"`, and this one is an invariant — so instead of
demoting to the legacy path it aborts the entire compile.

Two separable questions, and they should not be conflated:

1. **Should this be an invariant at all?** If the IR genuinely cannot lower this
   return shape, demoting to legacy is the documented behaviour of the IR
   overlay (see the IR fallback budget in `CLAUDE.md`), and a whole-program
   abort for one function is disproportionate.
2. **The underlying gap** — a function returning a concrete value where the IR
   requires a dynamically boxed one, with no boxing inserted.

Fixing (1) alone would unblock the graph but silently widen the legacy surface,
which #2855 is actively trying to shrink; it should be a deliberate decision,
recorded, not a side effect.

## Acceptance criteria

- A reduced fixture reproduces the invariant without ESLint.
- An explicit decision on (1), recorded here with reasoning — demote to
  warning, or keep fatal and fix the lowering.
- If the lowering is fixed: the concrete→dynamic boxing is inserted and the
  function is IR-emitted, with the IR fallback baseline updated if any bucket
  moves.
- ESLint `linter.js` advances past this diagnostic.
