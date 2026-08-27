---
id: 1609
title: "codegen: non-literal spread argument in new-expression not supported"
status: in_progress
created: 2026-05-24
updated: 2026-08-27
priority: high
feasibility: hard
assignee: ttraenkler/codex-es6-new-spread
task_type: feature
area: codegen
language_feature: spread, new-expression
goal: compiler-correctness
sprint: Backlog
related: [1320, 1620, 1633]
es_edition: es2015
test262_count: 18
---
# #1609 — Non-literal spread in `new` expression unsupported

## Problem

18 test262 tests fail with:

```
new FunctionExpression with non-literal spread not supported
```

All are `language/expressions/new` spread tests where the constructor is
invoked with `new F(...iterable)` and the spread operand is a non-array-literal
(an iterator, a variable, an expression that throws mid-iteration).

## Failing test examples

- `test/language/expressions/new/spread-sngl-expr.js`
- `test/language/expressions/new/spread-sngl-iter.js`
- `test/language/expressions/new/spread-err-sngl-err-itr-step.js`

## Root-cause hypothesis

Spread-in-`new` codegen only handles the array-literal fast path
(`new F(...[a, b])`) and bails on the general iterator-protocol spread. The
call-expression path already supports general spread; the `new`-expression
path in `src/codegen/expressions.ts` needs the same iterator-protocol
expansion (build the argument array from the iterator, then apply to the
constructor). Reuse the existing call-spread lowering for the construct path.

## Acceptance criteria

- `new F(...iter)` with a non-literal iterable compiles.
- >=14 of the 18 tests move off `compile_error`.

## Investigation 2026-05-27 (dev-1604) — root-cause hypothesis is wrong; BLOCKED on iterator bridge

The "reuse call-expression spread lowering" hypothesis underestimates the work.
Findings from inspecting the actual failing test262 files
(`language/expressions/new/spread-*`):

1. **Every** failing test invokes an anonymous `new function() { ... }` with
   **no formal parameters** and reads `arguments.length` / `arguments[i]`.
   So there is no formal-param subset to expand a spread into — the spread
   result must populate a **dynamic-length `arguments` object**.
   `compileNewFunctionExpression` (src/codegen/expressions/new-super.ts:854)
   builds a *static* `arguments` vec from a **compile-time-fixed** formal/flat
   arg count (lines 1064-1078). A runtime-variable spread length breaks that
   assumption outright.

2. The non-literal sources are custom `Symbol.iterator` objects
   (`spread-sngl-iter`, `spread-mult-iter`) and assignment expressions / vars
   holding plain arrays (`spread-sngl-expr` = `...(target = source)`), plus a
   block of error tests (`spread-err-*-itr-step/value/get-*`) that require
   driving an arbitrary iterator and propagating a **mid-iteration throw**.

3. `compileSpreadCallArgs` (src/codegen/expressions/extern.ts:404) — the
   lowering the issue suggested reusing — only expands a **vec-struct
   (compiled-array) source into a fixed param count**. It does NOT drive a
   general `Symbol.iterator`. Confirmed: even the *plain call* path emits
   invalid Wasm for `f(...customIterObj)` ("not enough arguments on the stack").
   Only a typed-array variable (`number[]`) spread compiles to valid Wasm today.

**Conclusion**: #1609 needs (a) a runtime iterator-protocol driver producing a
dynamic-length argv, and (b) a dynamic-argv lifted constructor to build
`arguments`. That is the **same iterator-bridge infrastructure as #1620 /
#1633** (the latter escalated NEEDS-SPEC for exactly this). This issue is
**blocked on #1620 / #1633**, not a localized dev fix. Re-route after the
iterator bridge lands; reassess then whether the array-literal/typed-array
subset can be carved off as a partial win.

## Resume plan — 2026-08-27

The old dependency state is stale: #1620 and #1320 are now complete, and the
compiler has since gained native iterator/generator and dynamic call-boundary
infrastructure. #1633 still tracks broader `Array.from`/`Array.of` constructor
semantics, but it is no longer accepted as proof that these 18 `new` spread
rows remain structurally blocked. This checkpoint reopens #1609 for a bounded,
verify-first implementation attempt.

1. Rebuild the exact current ES2015 `language/expressions/new/spread-*` cohort
   from the maintained 11,704-path edition filter. Run every candidate alone
   in standalone and host modes with the pinned Test262 checkout, QuickJS
   artifact, LLVM 18, and at most two compiler workers; record exact statuses
   and signatures rather than carrying forward the historical count.
2. Partition the cohort into compiled-array/typed-array operands, arbitrary
   custom iterables, multiple spreads, and iterator abrupt-completion cases.
   Confirm whether the current ordinary-call spread and iterator drivers can
   produce a runtime argv carrier that constructor lowering can consume.
3. Select the largest cohesive host-pass cluster with a shared constructor
   call-boundary root cause. Implement dynamic argument collection once in
   shared construction machinery; preserve evaluation order, `this`/prototype
   construction, dynamic `arguments`, IteratorClose, and abrupt completion.
4. Add focused host/standalone controls for zero/one/multiple spread operands,
   mixed fixed and spread arguments, a custom iterable, `arguments.length` and
   indexed reads, constructor identity, iterator throws, and an adjacent
   already-passing literal-spread case.
5. Rerun the exact selected slice and complete candidate cohort in both lanes,
   mandatory repository gates, and a same-base pass-to-nonpass comparison.
   Record artifacts, counts, residual ownership, commit SHA, and handoff here.

### Acceptance

- The current candidate denominator and both-lane baseline are exact.
- The selected cohesive cluster reaches 100% standalone and host pass with
  zero failures, compile errors, timeouts, or skips and no pass regression.
- The implementation contains no fixture rewrites, runner exemptions, host
  oracle shortcuts, or forced array-only semantics for arbitrary iterables.
- The upstream PR uses the repository Description/CLA template and stays draft
  until the scoped fix is complete, current-main based, CI-green, and mergeable.
