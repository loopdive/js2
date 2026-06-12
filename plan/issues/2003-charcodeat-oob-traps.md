---
id: 2003
title: "charCodeAt out-of-range traps 'string offset out of bounds' instead of returning NaN"
status: done
completed: 2026-06-12
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: string-methods
goal: core-semantics
related: [2004]
origin: "2026-06-10 spec-conformance sweep (strings agent): verified on main"
---

# #2003 — js-string builtin charCodeAt traps on OOB, no guard emitted

## Problem

```ts
"abc".charCodeAt(99)   // wasm: RuntimeError: string offset out of bounds
                       // node: NaN
```

Also `charCodeAt(-1)`.

## Root cause

`src/codegen/expressions/calls.ts:7080-7099` — `charCodeAt` lowers to the
`wasm:js-string` builtin `charCodeAt`, which traps on OOB per the JS String
Builtins spec; no bounds guard is emitted, and the i32 result type can't
represent NaN anyway (§22.1.3.3 requires NaN → needs an f64/guarded path).

## Fix direction

Emit `(index >= 0 && index < len) ? builtin : f64.const NaN` with an f64
result type (or keep i32 fast path when the index is provably in range).

## Acceptance criteria

- OOB/negative indices return NaN; in-range behavior and perf unchanged

## Dupe check

#103/#1105/#1175 unrelated (native impls, validation). New.

## Frontmatter reconcile (2026-06-12)

Fixed by merged PR #1329; frontmatter was stale at `ready`. Flipped to `done` during sprint-62 planning triage.
