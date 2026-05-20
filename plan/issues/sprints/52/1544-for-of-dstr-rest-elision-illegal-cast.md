---
id: 1544
sprint: 52
title: "for-of / for-await-of destructuring of iterator results throws illegal cast"
status: ready
created: 2026-05-20
parent: 820
priority: high
feasibility: medium
goal: test262-conformance
test262_fail: 45
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

### Step 1 — Identify the cast site

Inspect `src/codegen/statements/for-of.ts` and find where the loop body
extracts the iterator value (the `value` field of the `{ value, done }`
record). The value is externref. The current code likely emits:

```wasm
local.get $iterResult
struct.get $iter_result_value      ;; or extern_get
ref.cast $patternStruct             ;; ← THIS TRAPS
local.set $patternSource
;; destructure $patternSource
```

The `ref.cast` is unsafe when the runtime value isn't the inferred type.

### Step 2 — Route through the externref destructure path

Switch the loop body to use the same externref-destructure machinery the
function-parameter path uses (`destructureParamObject` /
`destructureParamArray` in `src/codegen/destructuring-params.ts`):

**File: `src/codegen/statements/for-of.ts`** (and async sibling)

Replace the direct-cast destructure with:

```ts
// Allocate an externref tmp for the iterator value
const valTmp = allocLocal(fctx, `__forof_val_${fctx.locals.length}`, { kind: "externref" });
fctx.body.push({ op: "local.tee", index: valTmp } as Instr);

// Branch on pattern kind
if (ts.isArrayBindingPattern(declList[0]!.name)) {
  destructureParamArray(ctx, fctx, valTmp, declList[0]!.name as ts.ArrayBindingPattern,
    { kind: "externref" });
} else if (ts.isObjectBindingPattern(declList[0]!.name)) {
  destructureParamObject(ctx, fctx, valTmp, declList[0]!.name as ts.ObjectBindingPattern,
    { kind: "externref" });
}
```

This routes through `emitExternrefDestructureGuard` (which throws a JS
TypeError, not a wasm trap) and `__array_from_iter` / `__extern_get` for
field extraction — same as function params.

### Step 3 — Async iter parity

For `for await`, the iterator value comes out of `await __async_iter_next()`.
After the await, the same externref-destructure routing applies. Confirm that
the lifted async-body closure preserves the destructure-output locals (same
pattern as #1543 — destructure to plain locals before they're captured into
the closure env).

### Wasm IR pattern

```wasm
;; loop body entry — $iterResult is the IteratorResult externref
local.get $iterResult
call $__extern_get  ;; get "value" field — returns externref
local.tee $loopVal

;; Destructure $loopVal as externref (safe, no cast trap)
local.get $loopVal
ref.is_null
if
  global.get $msg_cannot_destructure_null_undefined
  call $__throw_type_error
  unreachable
end

;; For [...rest]: materialise via __array_from_iter, then read length + each idx
local.get $loopVal
call $__array_from_iter
local.set $matArr

local.get $matArr
call $__extern_length
i32.trunc_f64_s
local.set $lenI32
;; ... emit element binding loop
```

### Edge cases

- **Iterator value is not an iterable** (for the rest pattern): per spec, this
  is a TypeError at `[Symbol.iterator]` lookup. The current `emitExternrefDestructureGuard`
  only checks null/undefined. For non-iterable objects, the destructure must
  emit a `TypeError: x is not iterable` — but `__array_from_iter` already
  throws a JS TypeError for non-iterables, so the spec-compliance comes for free.
- **Iterator's `.next().value` getter throws**: the spec requires the destructure
  to propagate that error. Since we're calling `__extern_get` (or
  `__array_from_iter`'s iterator-walking helper) which uses the JS host, JS
  throws propagate as wasm tag throws — verify this routes back to the test's
  `assert.throws` handler.
- **for-of with `var` vs `let` vs `const`**: scoping differs; the destructure
  body is the same. Ensure all three lowering paths reuse the new code.
- **for-of `[]` empty pattern**: per spec, calls `IteratorStep` exactly once
  (advances the iterator one step). Already handled by `isPatternEmptyOnly`
  in `destructuring-params.ts:685`.

### Test files to verify

Smoke:
1. `test/language/statements/for-of/dstr/var-ary-ptrn-rest-id-iter-val-err.js`
2. `test/language/statements/for-of/dstr/var-ary-ptrn-elem-ary-rest-iter.js`
3. `test/language/statements/for-await-of/async-func-dstr-var-async-ary-ptrn-rest-id-elision.js`

Then run all `for-of/dstr/*` and `for-await-of/*-dstr-*` via test262 runner.

### Estimated impact

~45 official test262 fails. Plus possibly ~10 secondary tests in `for-of/dstr/`
that the cast trap was masking.

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
