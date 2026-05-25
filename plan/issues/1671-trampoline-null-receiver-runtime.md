---
id: 1671
slug: trampoline-null-receiver-runtime
title: "object-method trampoline / direct dispatch lost the real receiver → ~200 runtime null-derefs (completes #1669/#621)"
sprint: 55
status: in-review
created: 2026-05-25
updated: 2026-05-25
priority: high
feasibility: hard
task_type: bugfix
area: codegen
language_feature: object-method-closures, destructuring-params, generators, async-generators
goal: compiler-correctness
related: [1669, 1602, 1557]
---
# #1671 — object-method dispatch lost the real receiver (empty stub method func)

## Problem

#621/#1669 stopped the `__obj_meth_tramp_*` trampolines from emitting INVALID
wasm, but ~200 tests then **compiled and validated yet null-deref'd at
RUNTIME** (~160 `null_deref` + ~15 iterator-protocol "Cannot read properties of
null (reading 'next')"). 201/220 of the still-regressed set were under
`language/expressions` (163 `…/object/`, 38 `…/class/`). Representative:
`language/expressions/object/dstr/async-gen-meth-dflt-ary-ptrn-rest-id-exhausted.js`.

The initial hypothesis (the trampoline pushes a null externref for `this`) was
only a symptom-level read. The trampoline's `ref.null <objStruct>` for a method
read *as a value* (`var f = obj.m; f()`) is actually **spec-correct** — extracted
methods call with `this = undefined`. The real failures were **direct** calls
`obj.method()`, which never go through the trampoline.

## Root cause

An object-literal method's param signature is derived in THREE places that must
agree:

1. **Canonical `funcMap` pre-registration** — `ensureStructForType` (the method pre-registration loop)
   in `src/codegen/index.ts` (the `methodParams` loop). This is the func a
   *direct* call `obj.method()` dispatches through.
2. **Per-literal fork decision** — `compileObjectLiteralForStruct` in
   `src/codegen/literals.ts` (the `newParams` loop, #1557/#1602).
3. **Actual body compile** — `compileObjectLiteralForStruct` in `literals.ts`
   (the `methodParams` loop, ~line 1510).

The body compile (#3) routes **binding-pattern params through the externref
destructure path** (#1151 Gap B) and widens default-init `ref` params to
`ref_null`. The pre-registration (#1) did **neither**. So for a method with an
array/object binding-pattern param — e.g.
`async *method([, , ...x] = [1, 2]) {…}` — the canonical func was registered as
`(this, (ref null vec))` while the body compiled to `(this, externref)`.

That signature MISMATCH made the body-compile **fork a per-literal funcIdx**
(#1557 path) and leave the canonical `funcMap` entry an **empty stub body**
(`ref.null extern` for an externref result). A direct `obj.method()` dispatches
via `funcMap` (NOT the per-literal map), so it landed on the empty stub:
returned `null` instead of the async generator, and the test's `.next()`
trapped. The module still VALIDATED (the stub is well-typed) — that is exactly
why #621's valid-wasm property held while runtime broke.

#1602's earlier recovery (`db494631e`) only fixed the **nullability**-insensitive
case (`ref` vs `ref null` of the same struct typeIdx). The binding-pattern case
diverges in `kind` (`ref_null` vs `externref`), which `refTypesMatch` cannot
reconcile, so the spurious fork survived.

## Fix

Apply the SAME widening — default-init `ref→ref_null` AND binding-pattern
`→externref` (#1151 Gap B) — at BOTH the canonical pre-registration
(`index.ts`) and the fork-decision sig (`literals.ts` `newParams`), so all
three sig computations agree. No spurious fork happens; the real body lands in
the canonical func; `obj.method()` reaches it. #621/#1602's valid-wasm
properties are preserved (their tests still pass), and genuine sibling-arity /
genuine-type-divergence forks (#1557 Bug A, #1602 Bug B) still trigger — those
differ in arity or in a non-binding-pattern `kind`/`typeIdx`.

## Files

- `src/codegen/index.ts` — `ensureStructForType` (the method pre-registration loop) pre-registration
  param-type derivation (the `methodParams` loop).
- `src/codegen/literals.ts` — `compileObjectLiteralForStruct` fork-decision
  (the `newParams` loop).
- `tests/issue-1671-trampoline-null-receiver.test.ts` — RUNTIME regression
  tests (array/object/rest binding-pattern method dispatched directly reads
  `this` and returns the right value; would null-deref before the fix) + the
  real test262 async-gen-meth source running without trap.

## Verification

- New runtime tests pass; `tests/issue-1669-*`, `tests/issue-1602.test.ts`,
  `tests/issue-1557.test.ts` still pass.
- `tsc --noEmit` clean; biome introduces no new diagnostics on the edited files.
- Scoped runs of named `language/expressions/object/dstr` + `meth-` cases
  (`gen-meth-ary-ptrn-rest-id-direct`, `meth-ary-ptrn-elem-id-init-undef`,
  `async-gen-meth-dflt-ary-ptrn-rest-id-exhausted`) now PASS (return 1 / no
  trap), versus null-deref on `main` HEAD (4784639cb).
- Expected ~+190 test262 pass — restores the ~29,600 peak (sha 65844626e).
