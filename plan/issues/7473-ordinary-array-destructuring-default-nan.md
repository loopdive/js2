---
id: 7473
title: "Ordinary pipeline: a default in an array destructuring assignment gives NaN"
status: done
created: 2026-11-26
updated: 2026-11-26
completed: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
sprint: Backlog
related: [7456]
---

# #7473 — Ordinary pipeline: a default in an array destructuring assignment gives NaN

## Problem

A wrong answer on the ordinary pipeline, default target and `--target standalone` alike. Found while fixing
[#7456](7456-ordinary-shorthand-destructuring-script-var-wrong-value.md) (PR #7430).

## Reproduction (2026-11-26, `origin/main` `6694a8b839`)

Each body is `export function g() { <body> }` in a `.js` file; the function compiles through legacy.

| Body | node | js2wasm (both targets) |
| --- | ---: | ---: |
| `var n; [n = 5] = []; return n;` | 5 | NaN |
| `var n; ({ n = 5 } = {}); return n;` | 5 | 5 |
| `let n; ({ n = 5 } = {}); return n;` | 5 | 5 |
| `var { n = 5 } = {}; return n;` | 5 | 5 |

Only the array-pattern ASSIGNMENT form is wrong; the object forms and the declarations answer like node.

## Acceptance criteria

- The array form answers 5 on both targets; also with a present element (`[n = 5] = [7]` → 7), an `undefined`
  element (`[n = 5] = [undefined]` → 5), and nested defaults.
- Pin tests that fail on main.
- JS-environment output byte-identical except for programs with a default in an array destructuring assignment.

## Root cause

A tuple literal that a pattern contextually types pads a missing or `undefined` number element with the f64
`undefined` marker `UNDEF_F64_BITS` (`compileTupleLiteral`, #852/#866/#1024), so `[n = 5] = []` reads an
in-bounds f64 field holding the marker. The declaration path tests for it (`emitDefaultValueCheck`), but
`compileArrayDestructuringAssignment` hard-coded "an in-bounds f64 element is present" (`absent = 0`), so `n` took
the marker, which reads as NaN. The same `absent = 0` sat in the member-target default arm (`[o.x = 5] = []`) and
in the nested-pattern default arm of `emitArrayDestructureFromLocal` (`[[n = 5]] = [[]]`). Separately, an element
that is itself a pattern with a default (`[[n = 5] = []] = []`, `[{ n = 5 } = {}] = []`) matched no arm and was
skipped, leaving the target untouched.

## Implementation Plan

Module: `src/codegen/expressions/assignment.ts` only (legacy codegen; no IR change).

- One predicate, `emitElementIsUndefined(ctx, fctx, elemType, local)`: externref → `__extern_is_undefined`, ref →
  `ref.is_null`, f64 → bit compare against `UNDEF_F64_BITS`, i32 → 0. It replaces the three inline copies of the
  externref/ref/else test (identifier arm, member arm, nested arm) and adds the f64 case once.
- The identifier and member default arms of `compileArrayDestructuringAssignment` each carried a copy of the
  bounds-check + element read + absent flag (`buildInBoundsInit`). Fold them into one closure,
  `emitElementPresenceProbe(i, elemType)`, next to `emitElementGet`.
- `emitElementOrDefault(i, elemType, default, write)`: `absent ? write(<default>) : write(element)`, shared by the
  member target and the two new nested-pattern targets (object and array). Each branch writes its value at its
  own static type. A single value-or-default local does not work for patterns: `[[n = 5] = []] = []` types the
  element as the empty tuple `[]` and the default as `[number]`, and the struct coercion between them drops the
  field.
- Reused, unchanged: `emitAssignToTarget`, `emitObjectDestructureFromLocal`, `emitArrayDestructureFromLocal`,
  `attachDetachedAssignmentBodies`.

Quality criterion: no new copy of the absence test or the element probe; the function and the file both shrink.

Correctness criteria: the issue's table on both targets; present (`[7]`), `undefined`, and missing elements; `let`,
script-var and member targets; nested array and object patterns with defaults; the default runs exactly once when
absent and never when present; the source is evaluated once. JS-environment output byte-identical for every
program without a default inside an array destructuring assignment.

## Result (2026-11-26, base `origin/main` `c3b7be667a`)

- `tests/issue-7473-array-destructuring-assignment-default.test.ts`: 26 rows × 2 targets; 34 of 52 fail on main
  (17 per target), all 52 pass on the branch.
- JS-environment byte identity, default target, 3,480 programs (playground examples, every function-bearing
  template literal in `tests/equivalence/`, and test262 `expressions/assignment{,/dstr}`, `statements/{for-of,
  for-in,variable,let}/dstr` with the assert/sta/compareArray/propertyHelper harness): 3,476 identical; the 4 that
  differ all contain a default inside an array assignment pattern (`array-elem-init-evaluation.js`, the two
  `array-elem-put-obj-literal-prop-ref-init*.js`, one `issue-1550` equivalence source); 0 differ without one.
- test262 `expressions/assignment/dstr/{array,obj}-*` + `statements/for-of/dstr/array-*` (437 rows,
  `scripts/run-test262-paths.mts`): 419 pass on main and on the branch, on both targets, with the same non-pass set.

### Left out (same area, separate causes)

- `[b = true] = []` gives `false`: an i32 (boolean) slot has no `undefined` marker, so the padded `0` reads as
  present.
- An element the pattern types as the empty tuple: `[[n = 5] = []] = [[]]` never writes `n` (want 5), because
  `emitArrayDestructureFromLocal` treats a zero-field struct as no tuple and skips out-of-range tuple positions
  instead of firing their defaults; `[[n = 5] = []] = [[8]]` also loses the `8`, because the source literal is
  built as that empty tuple. Both read NaN on the branch, as on main.
- `[{ n = 5 } = { n: 3 }] = [{}]` gives undefined: `emitObjectDestructureFromLocal` fires a shorthand default only
  for an externref field, not for an f64 field holding the marker. That path also serves object-only patterns,
  so changing it would break their byte identity here.
- Declaration form `var [[n = 5] = []] = []` gives 0 (declaration path).
