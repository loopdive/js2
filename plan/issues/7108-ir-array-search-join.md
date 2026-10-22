---
id: 7108
title: "IR: lower Array indexOf / includes / join on number and string vecs (select:array-method-unsupported)"
status: done
sprint: current
created: 2026-10-21
updated: 2026-10-21
completed: 2026-10-21
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7106]
assignee: "ttraenkler/session-d"
# 2026-10-21 (#7108): the only god-file growth is the plumbing; the admission
# rules and the lowering live in src/ir/array-methods/.
#   select.ts            isPhase1ArraySearchOrJoin (needs select.ts's private
#                        proofs expressionIsProvenNumber/String, capabilityNo)
#                        + a two-line delegation from isPhase1Expr
#   from-ast.ts          one dispatch call in lowerMethodCall + its import
#   codegen/index.ts,
#   integration.ts       the classifyArrayElementFamily selection option, once
#                        per selection site (planIrOverlay / compileIrPathFunctions)
#   module-bindings.ts   re-export so codegen/index.ts keeps its existing edge
#                        (no new codegen->ir import edge)
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/codegen/index.ts
  - src/ir/integration.ts
  - src/ir/module-bindings.ts
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
  - src/ir/from-ast.ts::lowerMethodCall
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
---

# IR: lower Array indexOf / includes / join on number and string vecs

## Problem

On `--target standalone` the IR selector rejects every Array prototype method
except `push` (and the holey `filter`) with
`select:array-method-unsupported`. The full-corpus standalone run on main
(coordination PR #6583, comment 6303767453; artifact of 2026-10-21 14:09)
counts **2,670 tests / 2,676 units** behind this code.

## Census (measured 2026-10-21, this branch's base `3b3196effe`)

Local census over a 1-in-12 sample of `test/{annexB,built-ins,language}`
(4,051 files), compiled exactly like the CI standalone lane (original harness
assembly, `allowJs`, `trackIrOutcomes`, `JS2WASM_IR_SHAPE_DIAG=1` for the
arm detail):

| rejected call | unit (harness file) | sample rows | corpus estimate |
| --- | --- | ---: | ---: |
| `floatArrayConstructors.indexOf(arg)` | `isFloatTypedArrayConstructor` (testTypedArray.js, included by 2,080 tests) | 170 | ~2,040 |
| `buf.join(' ')` | `printStringCodePoints` (regExpUtils.js, included by 586 tests) | 28 | ~340–586 |
| other | — | 1 | — |

Every row is a **harness** unit; no test body reaches this arm first.

## What this slice lowers

`indexOf(x)`, `includes(x)` and `join()` / `join(sep)` on a vec whose checker
element type is entirely `number`, or entirely `string` when the IR itself
materialized the vec (a dense literal, or a `const` bound to one). Lowering is
a counted scan built from existing IR primitives — `vec.len`, `vec.get`,
slots, `for.loop`, `if.stmt`, `string.eq`, `string.concat` and the
mode-neutral `(f64) -> string` provider of the template-literal lowering — so
no new runtime helper and no new IR instruction (`src/ir/array-methods/`).

Semantics kept identical to legacy and node: IsStrictlyEqual for indexOf,
SameValueZero for includes, §23.1.3.18 rendering for join; legacy's f64
`undefined` / absence markers (`UNDEF_F64_BITS`, `HOLE_F64_BITS`) are never
found by a number search and render as `""`.

Admission is exactly the lowering's domain, so a claimed call never demotes at
build time: `fromIndex`, spread arguments, a non-proven separator, `any[]`,
boolean/object elements, and a `string[]` that crossed a call boundary (its
elements live in the boxed externref carrier) are refused pre-claim. The linear
backend supplies no element-family classifier and admits nothing. The empty
array inference treats the three read-only calls like `push` (not an escape),
so `const xs = []; xs.push(n); xs.join()` stays claimable.

## Measured effect

- Test262 census for this code: **unchanged**. Neither corpus site is in this
  slice's domain: `floatArrayConstructors` holds host TypedArray constructors
  in a legacy module `var` (not a number/string vec, and the receiver is not
  an IR binding either), and `buf` in `printStringCodePoints` is an EMPTY
  literal whose element type is closed by string pushes — the empty-array
  inference only knows `number`, and the IR has no `vec<string>` push.
- Typed code: number/string-literal search and join now compile on the IR
  (`tests/issue-7108-ir-array-search-join.test.ts`, standalone + gc, every
  result compared with node).

## Follow-ups (not in this PR)

1. `printStringCodePoints` (~586 tests): string element evidence for the empty
   array inference + `push` into `vec<string>`. Even then the unit stops next
   on `param-type-not-resolvable` (the untyped `string` param of its `for-of`),
   so the gain is a code shift, not an IR-emitted unit.
2. `isFloatTypedArrayConstructor` (~2,080 tests): needs the module-level
   constructor array as an IR binding and an identity (`ref.eq`) search over
   externref elements — part of #7106's harness work.
