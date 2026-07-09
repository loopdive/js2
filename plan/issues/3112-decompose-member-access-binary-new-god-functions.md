---
id: 3112
title: "Decompose the remaining lowering god-functions: compilePropertyAccess (3,183), compileBinaryExpression (3,015), compileNewExpression (2,930)"
status: ready
sprint: Backlog
created: 2026-07-09
updated: 2026-07-09
priority: low
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
depends_on: [3111]
related: [3102, 3105]
---

# #3112 — Decompose the remaining lowering god-functions

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured)

After `compileCallExpression` (#3111), the next tier of single-function
monoliths, same shape-cascade disease:

| Function                      | Size      | File                                        |
| ----------------------------- | --------- | ------------------------------------------- |
| `compilePropertyAccess`       | **3,183** | `src/codegen/property-access.ts:3458`       |
| `compileBinaryExpression`     | **3,015** | `src/codegen/binary-ops.ts:253`             |
| `compileNewExpression`        | **2,930** | `src/codegen/expressions/new-super.ts:2546` |
| `coerceType`                  | 1,328     | `src/codegen/type-coercion.ts:1310`         |
| `compileArrowAsClosure`       | 1,227     | `src/codegen/closures.ts:1818`              |
| `compileDateMethodCall`       | 1,217     | `src/codegen/expressions/builtins.ts:1382`  |
| `compileObjectDefineProperty` | 1,198     | `src/codegen/object-ops.ts:1287`            |

(27 functions ≥ 1,000 lines exist in src/ total; this issue takes the
lowering-cascade ones; #3108 takes the runtime-emitter ones.)

`property-access.ts` also duplicates against `expressions/assignment.ts` (46
duplicated 8-line windows — the read/write paths hand-copy the same
receiver-resolution scaffolds), and `new-super.ts` contains the ~7×
copy-pasted "emit typed default value" block plus the diverged
`compileSuperMethodCall`/`compileSuperElementMethodCall` pair already
catalogued in #1849.

## Approach

**Blocked on #3111 proving the pattern** (probe contract + `CallSiteInfo`
shared-state object + tail-first peeling + identity-per-commit). Apply the
identical recipe:

- `compilePropertyAccess` → `property-shapes/` probes: builtin-proto reads,
  native-string/array length fast paths, extern-class members, closed-struct
  field access, dynamic `__extern_get` fallback. Shared
  `MemberSiteInfo { receiverType, resolvedStruct, isOptional, … }`.
  **Design win to evaluate (fable):** the read (property-access.ts) and write
  (assignment.ts `compilePropertyAssignment`, 497 lines) paths should share
  receiver-resolution probes — resolve-once, then read-or-write — which is
  what eliminates the 46-window duplication class instead of just moving it.
- `compileBinaryExpression` → operator-family modules (arith/compare/
  equality/logical-assign/in-instanceof) — mostly already-clustered case arms;
  nearest to pure motion of the three.
- `compileNewExpression` → known-ctor table probes (builtin ctors, extern
  classes, user classes, dynamic new) + fold the ×7 typed-default block into
  the existing `defaultValueInstrs` helper (#1849 item, byte-identity
  provable individually).

## Safety story

Same as #3111: extended identity corpus per shape family, IDENTICAL per
commit, decline-means-no-emission probe contract, stop-and-document any
branch that resists extraction. `coerceType` is on the list only for a
cascade→table restructure IF provable; it is the most central function in
codegen (every coercion flows through it) — lowest priority, highest care.

## Estimated LOC delta

Net ≈ 0 (motion) − shared receiver-resolution + typed-default dedup ≈
**−500 to −900**. No function in the table above > 1,200 lines afterwards.

## Acceptance criteria

1. IDENTICAL identity proof per extraction commit.
2. `compilePropertyAccess`, `compileBinaryExpression`, `compileNewExpression`
   each < 1,200 lines.
3. Read/write receiver-resolution sharing evaluated with a written decision
   (do/don't + why) even if not implemented.
4. No test262 regression.
