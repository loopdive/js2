---
id: 2000
title: "Array(len) skips the RangeError check for non-integer lengths and materializes dense zeros instead of holes"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-10
completed: 2026-06-11
priority: low
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: array-methods
goal: core-semantics
related: [86, 2001]
origin: "2026-06-10 spec-conformance sweep (arrays agent): verified on main"
---

# #2000 — Array(3.5) returns [0,0,0] instead of throwing

## Problem

```ts
const a = Array(3.5);
a.length + "|" + JSON.stringify(a)
// wasm: "3|[0,0,0]" (no throw)   node: RangeError: Invalid array length
```

## Root cause

`src/codegen/literals.ts:2815-2824` (`compileArrayConstructorCall`) —
`i32.trunc_sat_f64_s` truncates the length with no `n !== ToUint32(n)`
RangeError check (spec §23.1.1.1 step 4.b), and `array.new_default` makes
dense zeros instead of holes (hole semantics tracked more broadly in
#2001).

## Fix direction

Emit the integer check and throw RangeError on mismatch. Hole
representation is out of scope here (see #2001) — the RangeError half is
the actionable part.

## Acceptance criteria

- `Array(3.5)` throws catchable RangeError; `Array(3)` keeps length 3

## Dupe check

#86 is the old "new Array" feature issue (done). New.

## Addendum (2026-06-11 standalone audit, fable agent)

Confirmed in standalone mode too: `new Array(-1)` does not throw
RangeError (returns normally). Fix should cover both backends.
