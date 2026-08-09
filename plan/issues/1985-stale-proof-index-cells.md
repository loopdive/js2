---
id: 1985
title: "stale-proof index cells: shift-walker-updated { idx } handles for captured func indices (#2043 Option 2b, incremental)"
status: blocked
blocked_by: [2167]
sprint: Backlog
created: 2026-06-10
updated: 2026-06-24
priority: medium
feasibility: hard
reasoning_effort: max
model: fable
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: compiler-correctness
parent: 2043
related: [2043, 1984, 1809, 1839, 1677, 618]
origin: "Child slice of #2043 (ratified Implementation Plan, Option 2b). Range validation (landed) cannot see IN-RANGE stale indices — captured before a +delta shift, still pointing at a real-but-wrong slot (the wasmtime 'expected externref, found i32' flavor). Cells make the capture itself shift-proof."
---

# #1985 — Stale-proof index cells (incremental Option 2b)

## Problem

A `funcIdx: number` captured into a JS local is a value copy: when a deferred
late-import flush shifts the function index space by `delta`, the copy goes
stale and — if still in range — emits a *valid-but-wrong* index that no range
check can catch. Every recurrence of the class (#1809, #1839, #1677) was one
of these captures.

## Approach (ratified in #2043): incremental cells, NOT a big-bang symbolic rewrite

Replace raw captured indices with a shared cell `{ idx: number }` that the
shift walkers (`shiftLateImportIndices`, `addUnionImports`'s inline shift,
`addStringImports`'s inline shift, `reconcileNativeStrFinalizeShift`) update
in place, so every holder observes the shift. Concrete first targets — the
three sites that have actually recurred:

1. `pendingMethodTrampolines[].methodFuncIdx` (#1809).
2. `ctx.nativeStrHelpers` entries (#1839, #1677 Signature A).
3. The lazy `ensureNativeStringExternBridge` / late-import bridge captures
   (`src/codegen/expressions/late-imports.ts`).

Option 2(a) — fully symbolic references resolved once inside `emitBinary`
after the last shift — remains the end-state for NEW emission paths, but a
wholesale migration is explicitly rejected: the #618 revert (−3,931 tests
from an eager `fixupModuleFuncIndices` inside `addImport`) showed big-bang
shift-regime changes are the riskiest change shape in this codebase. With
#2043's emit validation and #1984's freeze-point landed, every remaining
instance is a *located compile error*, so cells can migrate site-by-site at
low risk.

## Acceptance criteria

- A `FuncIdxCell` (or equivalent) type; the three target sites hold cells;
  the shift walkers update cells exactly once per shift (no double-shift —
  pin with a unit test that runs two consecutive shifts).
- The #1809 / #1839 / #1677 regression tests stay green.
- No default-GC-path behavior change (the #618 guard test in
  `tests/issue-1677.test.ts` stays green); CI test262 holds the pass count.
- Document in `CLAUDE.md` (addUnionImports section) that new captures of
  function indices across potential flush points MUST use cells.
