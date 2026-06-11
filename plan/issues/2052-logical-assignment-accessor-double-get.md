---
id: 2052
title: "||= / &&= (and ref-typed ??=) on accessor properties call the getter twice on the keep path"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: logical-assignment
goal: core-semantics
related: [1819, 1250]
origin: "2026-06-10 deep-audit sweep (eval-order agent): verified miscompile on main"
---

# #2052 — logical assignment on accessors: getter fires twice on short-circuit

## Problem

Per [§13.15.2 Runtime Semantics](https://tc39.es/ecma262/#sec-assignment-operators-runtime-semantics-evaluation),
`a.x ||= v` performs GetValue exactly **once**. The compiler emits two getter
calls on the short-circuit ("keep") path — observable with side-effecting or
non-idempotent getters.

## Repro (verified on main)

```ts
let gets = 0; let sets = 0;
class A {
  _x: number;
  constructor(v: number) { this._x = v; }
  get x(): number { gets++; return this._x; }
  set x(v: number) { sets++; this._x = v; }
}
export function t1(): number { gets = 0; sets = 0; const a = new A(0); a.x &&= 9; return gets * 100 + sets * 10 + a._x; }
export function t3(): number { gets = 0; sets = 0; const a = new A(5); a.x ||= 9; return gets * 100 + sets * 10 + a._x; }
```

| fn | wasm | node |
|----|------|------|
| `t1` | `200` (2 gets) | `100` (1 get) |
| `t3` | `205` | `105` |

Non-short-circuit paths are correct (`||=` falsy → 119 both; `&&=` truthy and
`??=` paths match).

## Root cause

`src/codegen/expressions/assignment.ts`, `emitLogicalAssignmentPattern`: the
`||=` arm emits `emitGet()` for the condition (line ~3997) and then `emitGet()`
**again** as the keep-branch result (line ~4001); same for `&&=` (4022 + 4035)
and ref-typed `??=` (3958 + 3985). For identifier targets `emitGet` is a
`local.get` (harmless), but for accessor targets `emitFieldGet`
(assignment.ts:3411-3416) is a real getter **call**. The externref fallback
(`compilePropertyLogicalAssignmentExternref`, line 3485) shares the pattern via
`__extern_get`.

## Fix direction

Tee the first `emitGet()` result into a temp local before the truthiness test
and reuse the temp as the keep-branch value — one-line change per arm in
`emitLogicalAssignmentPattern` (and the identifier-path twin at lines
3315-3320/3342-3357 if accessors ever route there).

## Acceptance criteria

- Getter invoked exactly once for `&&=`/`||=`/`??=` on accessor properties,
  both keep and assign paths
- Setter still fires only on the assign path
- Equivalence suite green

## Dupe check

Grepped `getter twice`, `twice.*getter`, `GetValue once`, `logical assignment`:
#50, #194, #286, #415, #424, #1250, #1268, #1819 (all done; compile errors,
struct resolution, global-index offsets, `??=` NaN). None mention double getter
evaluation.

## Resolution (2026-06-11)

Fixed in `emitLogicalAssignmentPattern` (`src/codegen/expressions/assignment.ts`)
by teeing the first `emitGet()` result into a temp local before the truthiness
test and reusing the temp as the keep-branch value, instead of calling
`emitGet()` a second time. Applied to all three arms (`??=` ref path, `||=`,
`&&=`). For identifier targets `emitGet` was a harmless `local.get`; for accessor
targets it was a real getter call, now invoked exactly once. The ref-typed `??=`
arm previously teed into `tmpForUndef` only for externref and discarded it —
generalized to tee for all ref types and reuse on the keep path.

### Test Results

Added 5 accessor cases to `tests/equivalence/logical-assignment-property.test.ts`
(`&&=`/`||=`/`??=` keep+assign, getter/setter call counts via side-effecting
accessor). All 13 tests in that file pass. The repro returns `100`/`105` (one
get) instead of `200`/`205` (two gets). No new regressions in
logical-operators / coalesce / compound-assignment suites (the 3 pre-existing
`void x` TS-strictness failures in logical-conditional-identity also fail on
main, unrelated to this change).
