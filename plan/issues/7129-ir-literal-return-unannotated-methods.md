---
id: 7129
title: "IR: unannotated class methods returning one primitive literal kind resolve that kind; census of return/param-type-not-resolvable in test262"
status: done
sprint: current
created: 2026-10-22
updated: 2026-10-25
completed: 2026-10-22
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir
goal: ir-full-coverage
parent: 7106
# 2026-10-22: +9 lines in resolveReturnType (literal-return arm for methods); helper lives in select-expression-structure.ts
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/select-expression-structure.ts
---

## Problem

`return-type-not-resolvable` / `param-type-not-resolvable` were the second
largest legacy-unit buckets in the standalone test262 census (rc-3: 205 rows,
N=200 SEED=7). The task: cluster the unannotated JS functions by why their
type is unresolvable and make the largest exact cluster resolvable without
changing any call-boundary representation.

## Census (main `e99a0221`, standalone, N=200 SEED=7, `JS2WASM_IR_SHAPE_DIAG=1`)

| Cluster | Rows | Owner / status |
|---|---|---|
| `Test262Error` (`sta.js`, lattice=dynamic: self-guarded `return new F()` + fall-out) | 200 | #6829 (S3c) — in flight, not duplicated |
| `verifyAccessorProperty(desc)` (`propertyHelper.js`), param lattice not unknown/dynamic | 23 | propertyHelper stack (#6843/#6847); the body would refuse next anyway |
| `makeArrayLike` (`testTypedArray.js`), mixed dynamic/object-literal return | 13 | needs boxing a concrete object into the dynamic carrier (move-only scan) |
| unannotated class methods returning literals (`m() { return 42 }`, `static a() { return 'A' }`) | 4 | **this issue** |
| value-less class method (`f() { this.#m = 42; }`) | 1 | #6856 |
| `decimalToPercentHexString` (move-only[concrete]) | 1 | — |

An N=800 SEED=11 run showed the same shape: everything except `Test262Error`
is single-harness-helper clusters.

## Change

Class methods carry no TypeMap lattice entry, so an unannotated method's return
always resolved `null`. Legacy's class descriptor (`buildIrClassShapes`) takes
the slot from the checker's inferred return. `resolveReturnType`
(`src/ir/select.ts`) now resolves a `MethodDeclaration` whose body always
terminates and whose every value return is the SAME bare number or string
literal (`uniformLiteralReturnKind`, `src/ir/select-expression-structure.ts`)
to `f64` / `string`. The checker widens a single return literal to `number` /
`string`, so the IR signature equals the legacy slot. No call boundary changes.

The arm is gated to the host-free lanes (standalone, WASI, the native regime
in a JS environment) with the same `jsHostExternsEnabled` predicate the
sibling admissions use, so host-assisted gc output stays byte-identical
(review of PR #6863: a method body that is not a bare literal tail — the same
literal on two paths, or a class nested in `run()` — lowers differently under
the IR, so the un-gated arm moved host-assisted bytes).

Refused on purpose: boolean literals (legacy's class-method slot for an
inferred `boolean` does not match the IR bool signature — `typeIdx parity
mismatch`, measured), two distinct literals (`return 1` / `return 2` infer the
union `1 | 2`, which legacy's descriptor does not register), mixed kinds, any
non-literal return, bare `return;`, and bodies that can fall out
(`T | undefined`).

## Measured

- Census N=200 SEED=7: `return-type-not-resolvable` 205 → 201; the four
  methods (`C_m`, `C_m2`, `C_a`, `C_c`) ship IR bodies; no other bucket moved.
  `ir_only_pass` is unchanged: every row still holds `Test262Error` (#6829).
- Conformance A/B (standalone, QuickJS provider built per tree), 40 class
  tests incl. both affected files: 32 pass / 5 fail / 3 CE before and after,
  no row changed.
- `tests/issue-7129-literal-method-return.test.ts`: IR body, legacy answer and
  node agree on standalone and gc native-first (4 shapes × 2 lanes); the same
  4 shapes stay `return-type-not-resolvable` on gc host-assisted; the boolean
  and non-literal refusals carry that code (not a body-shape code); 18 direct
  rows on `uniformLiteralReturnKind`, including the distinct-literal union.
- Byte probe (sha256 of `result.binary`, merge base `7cc5d52322` vs head),
  `semanticProviders: "host-assisted"` on gc: identical for the two
  non-literal-tail shapes, the two literal-tail shapes and three no-shape
  programs. Standalone claims the literal shapes with node's result.

## What's left

1. Method bodies with a local `var` + `if` around the literal returns refuse
   later as `class-member-unsupported` (not a type question).
2. Unannotated method parameters (`m(n)`) drop the class descriptor (#6856 §3).
3. `makeArrayLike`-style mixed returns need a concrete→dynamic box at return.
4. Three mechanisms now infer an unannotated return kind — `declarationReturnKind`
   (`src/ir/type-evidence.ts`, checker signature), `seedReturnType`
   (`src/ir/propagate.ts`, #7133 literal-union collapse) and this syntactic
   scan; its visitor skeleton mirrors `irFunctionBodyReturnsValue`. A shared
   "collect value returns outside nested functions" helper would serve both.
5. The `mapped === undefined` conjunct is always true for a method at the only
   call site; it is defensive, mirroring the void arm.
