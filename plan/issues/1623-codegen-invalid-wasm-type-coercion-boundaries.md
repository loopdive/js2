---
id: 1623
title: "codegen: invalid Wasm binary at type-boundary coercion (extern/anyref + struct ref types)"
status: in-review
created: 2026-05-20
updated: 2026-05-28
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: type-coercion, externref, wasm-gc
sprint: Backlog
renumbered_from: 1522
es_edition: n/a
test262_category: multiple (Iterator, Promise, Temporal, super, class)
test262_count: 530
related: [1289, 1287, 1400]
---
# #1522 — Codegen emits Wasm modules that fail validation at type boundaries

## Problem

Across the test262 baseline (run 2026-05-20, 17,055 fails) **~530 tests**
fail with `invalid Wasm binary`. These are codegen bugs — the compiler
produces a module whose Wasm validator rejects it before any user code
runs. Sub-clusters by failure shape:

| Count | Shape | Likely root cause |
|-------|-------|-------------------|
| 55 | `extern.convert_any expected anyref, found global.get of type externref` | Coercion path forgets that the global is already `externref`, double-wraps |
| 11 | `struct.get expected (ref null N), found local.get of (ref null M)` | Lost type identity at struct field load — mostly Temporal `order-of-operations` tests |
| 6  | `f64.trunc expected f64, found local.get of type externref` | Compound-assignment skips unbox for `externref` operand |
| 4  | `any.convert_extern expected shared externref, found global.get f64` | privatename / private-field paths emit wrong source type |
| 4  | `f64.ne expected f64, found local.get externref` | line-terminator tests — `!=` against an externref-typed binding |
| 3  | `any.convert_extern expected externref, found ref.cast null …` | `await-using` / Reflect — externref boxing layered on ref.cast |
| 2+ | `type error in fallthru (expected (ref null N), got externref)` | `super(...spread)` error-path return type widened to externref |
| 2  | `not enough arguments on the stack for if (need 1, got 0)` | `Array.prototype.filter` species-undefined — branch leaves stack empty |
| 2  | `not enough arguments on the stack for array.set (need 3, got 2)` | `Array.prototype.map` species-null — store path missing value |
| 2  | `not enough arguments on the stack for local.set (need 1, got 0)` | `Array.prototype.reduce` accumulator path drops result |
| 2  | `local.set expected (ref null 21), found struct.get of type f64` | `toLocaleString` resizable-buffer — wrong typed temp |

This is **distinct from** the ESLint-specific failures already filed
(#1287, #1289, #1400) — those were narrow worktree examples; this
ticket is an umbrella for the general type-boundary coercion gaps
showing up across the test262 corpus.

## Failing test examples

- `test/built-ins/Iterator/from/result-proto.js` — extern.convert_any double-wrap
- `test/built-ins/Promise/all/resolve-before-loop-exit.js` — extern.convert_any double-wrap
- `test/built-ins/Temporal/Duration/prototype/round/order-of-operations.js` — struct.get ref-type mismatch
- `test/language/expressions/compound-assignment/S11.13.2_A6.11_T1.js` — f64.trunc on externref
- `test/language/expressions/super/call-spread-err-sngl-err-expr-throws.js` — fallthru type
- `test/built-ins/Array/prototype/filter/create-species-undef.js` — not enough args on stack
- `test/built-ins/Array/prototype/map/create-species-null.js` — array.set missing arg

## Approach (high level)

1. Cluster the failures by Binaryen validator message — done in this issue.
2. For each shape, write a minimal repro into `.tmp/` and walk the IR
   before lowering to find where the type assumption diverges.
3. Most shapes look like missing/duplicate `coerceType` calls at
   value-flow joins (globals, struct fields, branch fallthrough).

## Acceptance criteria

- The 5 biggest sub-clusters (≥ 200 fails combined) compile to valid
  Wasm — even if the runtime semantics still differ.
- No new compile-error regressions in test262.
- Add at least one targeted regression test per fixed shape under
  `tests/`.

## Estimated impact

**~530 test262 compile errors** today; some unblock further runtime
fails behind them, so realised gain may exceed the raw count.

## Fix 2026-05-28 (issue-1623-extern-doublewrap / dev-1623) — sub-cluster #1

Targets the dominant sub-cluster: 53 fails with shape
`extern.convert_any[0] expected type anyref, found global.get of type externref`.

**Root cause.** `compilePropertyAccess` in `src/codegen/property-access.ts`
at the `(#799 WI4) Property not found on struct ... fall back to
__extern_get` branch unconditionally emits `extern.convert_any` after
compiling the receiver expression. The comment says "Coerce struct ref to
externref" but the receiver can already be externref — most notably `this`
inside a `static` method, where `compileExpression(expr.expression)`
returns the static class-object global (externref). `extern.convert_any`
expects an `anyref` operand, so the validator rejects the module.

**Fix.** Capture the receiver's compiled type and call `coerceType` to
emit the correct conversion (which is a no-op when source equals
destination kind):

```ts
const recvType = compileExpression(ctx, fctx, expr.expression);
if (recvType && recvType.kind !== "externref") {
  coerceType(ctx, fctx, recvType, { kind: "externref" });
}
```

(was: bare `extern.convert_any` after `compileExpression`).

**Repro** (was: `compile_error`, now: compiles and runs):

```ts
class C {
  static set #f(v) { throw new Error(); }
  static getAccess() { return this.#f; }
}
```

**Impact on the four canonical fails listed in this issue:**

| Test | Before | After |
|------|--------|-------|
| `Iterator/from/result-proto.js` | compile_error (extern.convert_any) | fail (runtime — `Cannot convert null to object`) |
| `class/elements/static-field-declaration.js` | compile_error | fail (assertion mismatch) |
| `class/elements/get-access-of-missing-private-static-getter.js` | compile_error | fail (assertion mismatch) |
| `Promise/prototype/then/capability-executor-called-twice.js` | compile_error (`found call of type externref`) | unchanged — different sub-cluster (#1623b) |

The first three are now valid Wasm; the runtime failures are downstream
issues outside the type-coercion scope. The Promise case is a different
shape (call-of-externref-result rather than global.get-of-externref) and
is not addressed by this fix.

**Scope.** Single-site fix in `src/codegen/property-access.ts:2517-2519`.
Adds `coerceType` to the imports from `./type-coercion.js`. Regression
test in `tests/issue-1623.test.ts`. 38 nearby tests (`#1605`, `#1680`,
`#1681`, `#1682`, `#1683`, `#1612`, `#1605-cpn`) still pass.

### Companion fix in `src/codegen/fixups.ts`

The peephole/late fixup passes (`fixupStructNewResultCoercion` and
`fixupExternConvertAny`) resolved `global.get` operands via
`ctx.mod.globals[gIdx]`. That array stores only the module-defined
globals — imported globals occupy the lower part of the combined Wasm
global index space. For any module that imports globals (the common
case), `globals[gIdx]` returned `undefined` for every import-side
index, so the safety net missed all redundant `extern.convert_any`
ops over imported externref globals.

Added a `getGlobalType(gIdx)` helper to both passes that resolves
combined indices against `ctx.mod.imports` first, then falls back to
`ctx.mod.globals`. Of the 53 baseline tests in the
`global.get of type externref` sub-cluster, 46 now compile to valid
Wasm (the remaining 7 are unrelated TS compile errors or different
codegen shapes). Regression test in
`tests/issue-1623-extern-doublewrap.test.ts`.

