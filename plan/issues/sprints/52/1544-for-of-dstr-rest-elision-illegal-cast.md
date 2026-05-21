---
id: 1544
title: "for-of / for-await-of destructuring of iterator results throws illegal cast"
status: ready
created: 2026-05-20
spec_done: 2026-05-20
parent: 820
priority: high
feasibility: medium
goal: test262-conformance
test262_fail: 45
shares_fix_with: [1543]
root_cause_doc: 1556
note: "Verified 2026-05-21 — shares fix with #1543; both gated by literals.ts:447 (confirmed present)"
---

# #1544 — for-of / for-await-of dstr rest/elision → illegal cast

## Problem

Destructuring patterns used as the binding of `for-of` and `for-await-of`
iterate-and-bind throw a wasm "illegal cast" when the iterator yields values
that don't match the pattern's expected struct shape, instead of either
completing the binding or throwing the spec-mandated error from the iterator
protocol.

### Minimal repro 1 — for-of with rest

```js
var poisonedValue = Object.defineProperty({}, 'value', {
  get: function() { throw new Test262Error(); }
});
var iter = {};
iter[Symbol.iterator] = function() {
  return { next: function() { return poisonedValue; } };
};

assert.throws(Test262Error, function() {
  for (var [...x] of [iter]) { return; }
});
// expected: Test262Error from the getter on `value`
// actual:   wasm "illegal cast" before the getter ever fires
```

### Minimal repro 2 — for-await-of with array pattern

```js
async function fn() {
  for await (const [a, b, ...rest] of [{[Symbol.iterator]: () => makeIter()}]) {}
}
// expected: pattern destructures async iterator results
// actual:   wasm "illegal cast" inside lifted async body closure
```

### Test262 coverage (~45 official fails)

- `test/language/statements/for-of/dstr/var-ary-ptrn-rest-id-iter-val-err.js` (and `const-*`, `let-*`)
- `test/language/statements/for-of/dstr/var-ary-ptrn-elem-ary-rest-iter.js`
- `test/language/statements/for-of/dstr/const-ary-ptrn-rest-id-iter-val-err.js`
- `test/language/statements/for-await-of/async-func-dstr-var-async-ary-ptrn-rest-id-elision.js`
- `test/language/statements/for-await-of/async-func-dstr-let-async-ary-ptrn-elem-ary-rest-init.js`
- `test/language/statements/for-await-of/async-gen-dstr-const-async-ary-ptrn-elem-ary-rest-init.js`

Bucket counts from latest baseline:
- `L41:3 illegal cast [in test()]` (sync for-of): 20
- `L59:3 illegal cast [in fn() ← test]` (for-await-of in async fn): 9
- `L79:3 illegal cast [in fn() ← test]` (for-await-of in async gen): 9
- `L71:3 illegal cast [in __closure_6() ← assert_throws ← test]` (assert.throws wrapper): 9

## Root cause hypothesis

The for-of/for-await-of body lowering in `src/codegen/statements/for-of.ts`
(and the for-await-of equivalent — verify path) emits the destructure pattern
**directly against the iterator-yielded value's wasm type**, but the iterator
result type from `__iter_next` is `externref` (boxed `{ value, done }`).

The destructure pattern expects either:
- A vec ref (for `[a, b, ...rest]`) — needs `__array_from_iter` materialisation
- A struct ref (for `{ x, y }`) — needs `__extern_get` per-field reads

The current code-path appears to perform a **direct `ref.cast`** from the
iterator result to the pattern's expected struct, which traps when the value
is a JS object (externref) rather than the inferred wasm struct.

### Where to look

- `src/codegen/statements/for-of.ts` — for-of statement compilation
  - Look for the binding-pattern emission inside the loop body
  - Find the `ref.cast` after the `__iter_next` call (or its inline equivalent)
- `src/codegen/statements/for-await-of.ts` (if it exists; else inside `for-of.ts`
  with a `for-await` branch) — async iter protocol
- `src/codegen/statements/destructuring.ts:480` — `"Cannot destructure: not a
  known struct type"` error site (suggests this code-path attempts a
  type-directed destructure)

Grep target:
```
grep -n "for.*of\|forOf\|asyncIter\|__iter_next\|__async_iter_next" \
  src/codegen/statements/for-of.ts src/codegen/statements/*.ts
```

## Implementation Plan

> **Supersedes** the prior "switch to externref-destructure inside the
> for-of body" plan. Root-cause analysis in #1556 shows that #1544's
> illegal cast and #1543's illegal cast share **one** underlying defect:
> binding-pattern parameter / per-iteration-binding defaults emit as
> typed structs whose field types disagree with the binding locals'
> declared types. The for-of body is one of three failure shapes (#1556
> Shape 2 / Shape 3); the fix is at the binding-pattern emission layer,
> not in the for-of statement code.
>
> The for-of family still requires **one additional audit** (described
> below) of the iterator-source `ref.cast` site that may be a Path C
> complement, but the primary fix is shared with **#1543**.

### Architectural decision: same as #1543

Apply the **B (narrowed) + D (defensive)** hybrid described in
**#1543's Implementation Plan**, supplemented by a Path C audit specific
to #1544 (next subsection). One coordinated patch closes both issues.

Of the three #1556 paths:

- **Path A** (widen all binding-pattern struct field types to externref):
  invasive (~150–200 lines), held in reserve.
- **Path B** (remove `literals.ts:447` binding-element exclusion): safe
  now that #852 added the `ref.test` / `__extern_get` fallback to
  `destructureParamObject:489-521`. ~10 lines.
- **Path C** (ref.test guards): runtime-only fix; insufficient alone for
  the compile-time validation error #1556 documents as Shape 1.

### Changes — shared with #1543 (same patch)

#### Primary — `src/codegen/literals.ts:447`

Function `compileObjectLiteral`. Remove the binding-element block:

```ts
// CURRENT (line 447)
if (expr.properties.length === 0 && !ts.isParameter(expr.parent) && !ts.isBindingElement(expr.parent)) {

// AFTER
if (expr.properties.length === 0) {
```

Update the stale comment at lines 442–446 (reference #1556 + this issue).

#### Defensive coercion — `src/codegen/destructuring-params.ts:620`

Function `destructureParamObject`, struct fast path. Pass `targetType`
to `emitDefaultValueCheck` so the default-fires path coerces fieldType →
localType (see #1543 plan for the exact edit).

#### Symmetric — `src/codegen/destructuring-params.ts:1115`

Function `destructureParamArray`, tuple struct path, `emitNestedBindingDefault`
call. Verify `effType = localType || fieldType` is honoured by
`emitNestedBindingDefault` for binding-pattern struct fields with
primitive types; if not, plumb `localType` through.

### Changes — #1544-specific Path C audit

After the shared B+D patch lands, #1544's remaining failures (if any)
narrow to two suspect sites in the for-of pipeline:

#### Audit site 1 — `compileForOfArray` element coerce

**File**: `src/codegen/statements/loops.ts:2064–2072`

```ts
fctx.body.push({ op: "local.get", index: dataLocal });
fctx.body.push({ op: "local.get", index: iLocal });
fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx });
const elemLocalType = getLocalType(fctx, elemLocal);
if (elemLocalType && !valTypesMatch(elemType, elemLocalType)) {
  coerceType(ctx, fctx, elemType, elemLocalType);
}
emitCoercedLocalSet(ctx, fctx, elemLocal, elemType);
```

When the iteration source is `[iter]` where `iter` is a custom object
with `[Symbol.iterator]`, TS may register `iter`'s type as an anonymous
struct, making `elemType = ref $anonIter`. `array.get` produces that ref;
`coerceType` to the binding pattern's local type may emit `ref.cast` if
the local was widened differently. **Verify** that `coerceType` for
`ref→ref` between unrelated struct types uses the `ref.test` guard
pattern, not a bare `ref.cast`. If it doesn't, add the guard following
the `type-coercion.ts:1019–1048` pattern referenced in #778.

#### Audit site 2 — `compileForOfDestructuring` array-pattern entry

**File**: `src/codegen/statements/loops.ts:862–904` (array binding,
non-ref `elemType`)

When `elemType` is the per-iteration value's type and it is a typed
struct (`ref $anon`) that is **not** a vec and **not** a tuple struct
(the `iter` case above), control flow falls through to lines 1003–1166's
vec-array path expecting `arrDef` to exist — line 992–995 reports
"for-of array destructuring: element is not an array type". This is a
compile-time `reportError`, NOT a runtime trap, so it would surface as a
CE in the baseline, not as `L41:3 illegal cast`.

If the runtime "illegal cast" persists for `var [...x] of [iter]` after
the B+D patch:

- The cast is happening at the Audit-1 site (struct → struct coerce).
- Add the `ref.test` guard there.

Otherwise, no further changes in `loops.ts` are needed — Path B + D
suffices.

#### for-await-of

`async-func-dstr-var-async-ary-ptrn-rest-id-elision` and friends route
through `compileForAwaitOf` (search `statements/loops.ts` for
`AwaitKeyword`). The destructure step inside the lifted async body runs
on a materialised vec, same as sync `for-of`. The same B+D fix applies.
If a separate `ref.cast` exists between the `await` resume and the
destructure entry, add the Path C guard there.

### Why the previous plan ("route through externref-destructure in the
loop body") was wrong

That plan would have widened **every** for-of iteration to externref —
including the perf-critical `for (const x of arr)` over typed arrays —
incurring a per-element `extern.convert_any` + `__extern_get` round trip
where today's code emits a single `array.get`. The actual bug is one
layer deeper: the *binding pattern's* type accounting, not the for-of
*iteration*.

### Wasm IR change (conceptual, #1544 path)

**Before** (var `[...x]` against `iter`):

```wasm
;; outer for-of over [iter] : iter[]
;; elemType = ref $anonIter (struct shape inferred from {[Symbol.iterator]: ...})
local.get $data
local.get $i
array.get $arr_anonIter            ;; pushes ref $anonIter
local.set $elem                    ;; OK so far

;; compileForOfDestructuring([...x], elemType = ref $anonIter)
;; falls into vec-array path expecting arrDef → reportError, OR
;; falls into Audit-1 site where coerceType ref → ref emits ref.cast → TRAPS
```

**After B+D** (binding-pattern emission fixed at param/decl level):

```wasm
;; The per-iteration binding [...x] is declared inside a VariableDeclarationList,
;; so it goes through compileArrayDestructuring (statements/destructuring.ts), NOT
;; the param destructure paths. Verify that path also benefits from the literals.ts:447
;; relaxation — when a destructuring DECLARATION has a synthesized default {} the
;; same compileObjectLiteral codepath fires.
```

**Path C complement** (if Audit-1 traps):

```wasm
local.get $data
local.get $i
array.get $arr_anonIter
local.tee $tmp
ref.test $expectedType
if (result (ref null $expectedType))
  local.get $tmp
  ref.cast_null $expectedType
else
  ;; convert to externref and re-route destructure through extern_get
  local.get $tmp
  extern.convert_any
  ;; ... externref destructure ...
end
```

### Edge cases to verify

- **`for (var [...x] of [iter])` where `iter` has a throwing `value` getter**:
  After B+D, the `[...x]` destructure routes through `__extern_get`
  (which calls JS `[[Get]]` and propagates the getter throw as a wasm
  tag exception). The test's `assert.throws(Test262Error, ...)` sees the
  thrown Test262Error — passes. ✓
- **`for (var [a, b, ...rest] of [{[Symbol.iterator]: () => makeIter()}])`**:
  The iterator-protocol entry walks the iterable; rest is built via
  `__extern_slice` (loops.ts:967–972) or `__array_from_iter`. Verify
  neither path emits a bare `ref.cast` against a non-vec source.
- **for-await-of**: same as for-of for the destructure step; the await
  point is independent of binding-pattern emission.
- **`const` vs `var` vs `let`**: TDZ handling unaffected by this fix.
- **Empty rest** `for ([,] of arr)`: spec calls `IteratorStep` once per
  elision (#1432). Already handled in
  `destructuring-params.ts:isPatternEmptyOnly`; not regressed by B+D.

### Regression gate

Same as #1543 — run the full dstr family:

```bash
pnpm run test:262 -- --filter "language/destructuring/"
pnpm run test:262 -- --filter "language/statements/for-of/dstr/"
pnpm run test:262 -- --filter "language/statements/for-await-of/"
pnpm run test:262 -- --filter "language/statements/class/dstr/"
pnpm run test:262 -- --filter "language/expressions/class/dstr/"
pnpm run test:262 -- --filter "language/expressions/function/dstr/"
pnpm run test:262 -- --filter "language/expressions/arrow-function/dstr/"
```

Net pass must be ≥ 0 on each dir. If any dir regresses, fall back to
**Path A** (sibling-struct registration with widened externref fields —
see #1556).

### Test files to verify (smoke before push)

Each should produce a JS-level error or pass cleanly, NOT a wasm
"illegal cast" trap:

1. `test/language/statements/for-of/dstr/var-ary-ptrn-rest-id-iter-val-err.js`
2. `test/language/statements/for-of/dstr/var-ary-ptrn-elem-ary-rest-iter.js`
3. `test/language/statements/for-of/dstr/const-ary-ptrn-rest-id-iter-val-err.js`
4. `test/language/statements/for-await-of/async-func-dstr-var-async-ary-ptrn-rest-id-elision.js`
5. `test/language/statements/for-await-of/async-gen-dstr-const-async-ary-ptrn-elem-ary-rest-init.js`

### Complexity estimate

- Shared B+D patch (closes both #1543 and #1544): **~15 lines** across
  `literals.ts` and `destructuring-params.ts`.
- Audit-1 Path C guard in `loops.ts:2064–2072` (only if needed after
  B+D): **~10 lines**.

**Total ~15–25 lines**. Path A fallback if regression: ~150–200 lines.

### Shared with #1543

Both issues are closed by the same patch. The dev should:

1. Open one PR titled `fix(#1543,#1544): binding-pattern dstr struct-field type mismatch (B+D, ref #1556)`.
2. Run the regression gate listed above.
3. If for-of-specific failures remain after the gate passes, apply the
   Audit-1 ref.test guard from #1544 in a follow-up commit on the same
   PR.
4. On merge, set both issues to `status: done`.

## Acceptance criteria

- All `for-of/dstr/*-ary-ptrn-rest-*` and `*-ary-ptrn-elem-ary-rest-*` tests
  produce the expected JS-level error (or pass, when expected)
- `L41:3 illegal cast [in test()]` count drops by ≥15 in latest baseline
- `L59:3` and `L79:3` `illegal cast [in fn() ← test]` drop to ≤2 each
- No regressions in `for-of/*` non-dstr tests

## Related

- Parent: #820 (null/TypeError/illegal-cast umbrella)
- Sibling: #1542 (class method dstr default not applied)
- Sibling: #1543 (async-gen-meth dstr default → illegal cast)
- Related: #826 (illegal-cast umbrella follow-up)
- Related: #1016 (getter-throw destructure cluster)
