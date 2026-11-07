---
id: 7316
title: "DataView constructor evaluates the byteLength argument after the offset checks (spec: all arguments first)"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [7274]
---

# DataView constructor evaluates `byteLength` too late

## Problem

`new DataView(buffer, byteOffset, byteLength)` must evaluate all three
argument expressions before the constructor runs (§13.3.5.1 → ArgumentListEvaluation).
Only then does §25.3.2.1 perform ToIndex(byteOffset), the detached check,
the offset range check and ToIndex(byteLength).

Legacy's inline construct (`tryCompileIndexedBuiltinNew`, DataView arm in
`src/codegen/expressions/new-indexed.ts`, sequences in
`src/codegen/buffers/data-view-native.ts`) evaluates the length expression
only after the detached and offset-bounds checks. When the offset is out of
range it never evaluates it, so a side effect in that expression is lost.

The IR route (#7274 slice 2, `__ir_dv_new`) evaluates every operand first, as
the spec requires. Its admitted operands are number-typed or `undefined`, so
the difference is not observable there today. It will be once a
side-effecting operand can reach the IR route (a call or `try` in
module-init).

## Repro

```js
var ab = new ArrayBuffer(8);
var log = "";
function f() { log += "f"; return 1; }
try { new DataView(ab, 9, f()); } catch (e) { log += e instanceof RangeError ? "R" : "X"; }
assert.sameValue(log, "fR");
```

| Lane | Result |
| --- | --- |
| node | `fR` (pass) |
| gc | `R` (fail) |
| standalone | `R` (fail) |

Measured 2026-11-07 on #7161's head (1af545db) and on a84cddb1. The
standalone route is legacy.

## Acceptance

- The repro passes on gc and standalone.
- The length expression is evaluated before any ToIndex or range check,
  whether or not the offset is valid.
- gc output stays byte-identical for DataView constructions whose arguments
  are literals or plain reads (they have no side effects to reorder).
