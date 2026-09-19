---
id: 6635
title: "standalone: Map/WeakMap.prototype.get() chained directly into a computed member access (no intervening local) loses reads and drops writes — anyref receiver has no arm in compileElementAccessBody / compileExternSetFallback"
status: done
assignee: ttraenkler/sendev-s50
sprint: current
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
goal: standalone
parent: 5383
requested_by: ttraenkler/fable-lead
created: 2026-09-18
completed: 2026-09-18
loc-budget-allow:
  # 2026-09-18 (S50) — a single `if (objType.kind === "anyref") { extern.convert_any;
  # objType = externref }` guard added at the top of both
  # `compileElementAccessBody` (property-access.ts, the READ side) and
  # `compileExternSetFallback` (expressions/assignment.ts, the WRITE side).
  # Both files already carry a #5383-family grant from prior S-lanes; this
  # entry documents the S50-specific delta on top of it.
  - src/codegen/property-access.ts
  - src/codegen/expressions/assignment.ts
func-budget-allow:
  # 2026-09-18 (S50) — `compileElementAccessBody` grew (+28, comment-heavy)
  # adding the anyref guard ahead of its existing externref arm. Already
  # carries a #5383-family allowance; same kind of targeted guard-insertion.
  - src/codegen/property-access.ts::compileElementAccessBody
---

## Problem

`Map`/`WeakMap.prototype.get()` is intercepted by `tryCompileNativeMapMethodCall`
(`src/codegen/map-runtime.ts`, `ctx.nativeStrings`-gated) and reports its
return `InnerResult` as a bare `{kind:"anyref"}` — deliberately generic, since
a `Map<K, V>`'s value type is not narrowed to a concrete Wasm struct.

Every OTHER receiver kind that can reach a computed member access
(`compileElementAccessBody` for reads, `compileExternSetFallback` for writes)
has an explicit arm: `externref`, `f64`, `i32`, `ref`, `ref_null`. `anyref` had
none. Two call sites compile the object sub-expression with **no expected-type
hint** (`compileExpression(ctx, fctx, expr.expression)` in
`compileElementAccess`; `compileExpression(ctx, fctx, target.expression)` in
`compileElementAssignment`), so a `Map.get()` result used **directly** as the
object of a computed access — `someMap.get(k)[computedKey]` (read) or
`someMap.get(k)[computedKey] = v` (write) — never gets coerced to `externref`
the way the dot-property twins do (they route through `ctx.checker`-driven
compilation that requests `externref` explicitly, so `coerceType` widens
`anyref → externref` for free in the `#1919` wrapper).

**Read side**: the uncaught `anyref` fell to `compileElementAccessBody`'s
generic non-ref/non-externref fallback, which only recognizes `f64`/`i32` —
anything else hits `reportError(ctx, expr, "Element access on non-array
value"); return null;`. That `null` is not a compile failure: the `#1919`
speculative-rollback wrapper in `expressions.ts` treats a `null` inner result
as a probe miss, **silently discards the diagnostic and the partial body**,
and substitutes a TS-static-type-derived default value instead
(`mapTsTypeToWasm(ctx.checker.getTypeAtLocation(expr), ...)` →
`pushDefaultValue`). For an unresolvable/`any` computed-member type that
default is a bare `ref.null` — observably JS `null`, not `undefined`.

**Write side**: the same uncaught `anyref` fell to `compileExternSetFallback`'s
`reportError(ctx, target, "Unsupported element assignment target type");
return null;` arm — silently dropping the write (the RHS value is computed
for its side effects but never reaches `__extern_set`).

## Fix

Both functions now treat `anyref` the same way they already treat
`ref`/`ref_null`: a single `extern.convert_any` (the value is already on the
Wasm stack) widens it onto the SAME, already-correct `externref` read/write
pipeline every other object receiver uses (`__extern_get`/`__extern_set`).
Strictly additive — `anyref` previously reached only the broken fallback in
both functions, so no previously-working case changes.

## Verification

`tests/issue-6635-map-get-chained-computed-access.test.ts` — 6 tests: 2
fix-witnesses (chained READ, chained WRITE — both fail on a file-copy revert
of the two touched files to S49c's tip `76e5697eb2`, pass on the fix), 1
real-shape control (optional-chained `Q(e)?.[t]`, matches the real polyfill's
`re(e,t){const n=Q(e)?.[t];...}` exactly — passes on BOTH trees, a separate
codegen path `compileOptionalElementAccess` this fix does not touch), 3
controls (plain-function-chained access, `.get()` stashed to a local first,
`.get()` holding a primitive — all unaffected, pass on both trees).

`npx vitest run --maxWorkers=2 tests/issue-66*.test.ts tests/issue-6484-*.test.ts`:
37 files / 227 tests, 0 failed.

## S50 findings — this fix is real and necessary, but NOT sufficient to close
#5383's two named target rows

See `### S50 findings` in `plan/issues/5383-standalone-temporal-provider.md`
for the full reduction path, the WAT evidence pinpointing the actual failing
site for those two rows (`$__extern_get`'s own struct/field dispatch after a
DEVIRTUALIZED closed-method-dispatch call, not a Map.get() chain at all), and
the criterion-4 battery run against this fix.
