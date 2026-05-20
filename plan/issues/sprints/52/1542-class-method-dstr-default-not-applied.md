---
id: 1542
title: "Class method destructured-pattern param default not applied; throws \"Cannot destructure null\" instead"
status: suspended
created: 2026-05-20
parent: 820
priority: high
feasibility: hard
goal: test262-conformance
test262_fail: 134
---

## Suspended Work

**Suspended**: 2026-05-20 by dev-equiv-tests after smoke-testing.

**Worktree**: `/workspace/.claude/worktrees/issue-1542-class-method-dstr-default` (branch
`issue-1542-class-method-dstr-default`). Clean — no commits.

**Status**: Minimal repros all PASS on current main:
- `method({ x = 1 } = {})` → 1 ✓
- `method([,] = g())` with `function* g() { yield; }` → "ok" ✓
- Side-effect tracking with `let first/second` → matches JS ✓
- Private method `#m([,] = g())` ✓
- Static method `static m({ x = 5 } = { x: 10 })` ✓

But the baseline still shows 102+ failures (`Cannot destructure 'null' or 'undefined'`
across `C_method`, `C___priv_method`, `__anonClass_0___priv_method`). The failures
must require specific test262-harness shape that the simple repros don't trigger.

**Hand-off notes for senior-developer**:
- Architect spec at line 105+ proposes a `coerceType` branch for externref → vec
  via `__array_from_iter`. The fall-through at line 1019-1048 of
  `src/codegen/type-coercion.ts` is where opaque externrefs lose their iterable
  nature (today emits `ref.null` in the else of `ref.test`).
- Need to compile actual failing test262 file shape (with harness wrap) and
  trace the param-default code path to find the bug.
- One incidental observation while probing: array-elision `[,]` over a generator
  appears to advance the iterator one extra time (second=1 vs expected 0). This
  may or may not be a related bug.

Reprioritized to `feasibility: hard` because reproduction requires harness
shape; the architect's proposed `coerceType` change is the right hypothesis but
needs validation against the actual failing tests.

# #1542 — Class method destructured-pattern param default not applied

## Problem

Class methods (regular, generator, async-generator, private) whose parameter is a
**binding pattern with a parenthesised default** (e.g. `method([,] = g())`,
`method({ x = 1 } = {})`) throw

```
Cannot destructure 'null' or 'undefined' [in C_method() ← test]
```

when called with no argument (or `undefined`), instead of substituting the
default value and then destructuring.

Per ES spec §13.15.5.6 (KeyedBindingInitialization) and §13.3.3.6
(IteratorBindingInitialization), the param-level default must be evaluated
**before** the destructuring step runs against the value.

### Minimal repro

```js
function* g() { yield; }
class C {
  method([,] = g()) {           // default = g()
    return 'ok';
  }
}
new C().method();                // expected: 'ok'; actual: TypeError "Cannot destructure null"
```

```js
class C {
  method({ x = 1 } = {}) { return x; }
}
new C().method();                // expected: 1; actual: TypeError
```

### Test262 coverage (~134 official fails)

Sample paths (all match `L8:5 Cannot destructure 'null' or 'undefined' [in C_method()…]`):

- `test/language/statements/class/dstr/meth-dflt-ary-ptrn-elem-ary-elision-init.js`
- `test/language/statements/class/dstr/meth-dflt-ary-ptrn-elision.js`
- `test/language/statements/class/dstr/async-gen-meth-ary-ptrn-elem-ary-elision-init.js`
- `test/language/statements/class/dstr/gen-meth-ary-ptrn-elem-ary-elision-init.js`
- `test/language/expressions/class/dstr/async-private-gen-meth-static-dflt-obj-ptrn-prop-obj-init.js`
- `test/language/expressions/class/dstr/private-gen-meth-dflt-ary-ptrn-elision.js`
- `test/language/expressions/class/dstr/async-private-gen-meth-static-dflt-obj-ptrn-id-init-skipped.js`
- Family `private-meth-static-dflt-*`, `private-gen-meth-*`, `async-gen-meth-static-dflt-*`

The four broad message buckets (from latest baseline):
- `[in C_method() ← test]`: 57
- `[in C___priv_method() ← test]`: 38
- `[in __anonClass_0___priv_method() ← test]`: 24
- `[in C_method() ← test]` (15 additional class-decl variants): 15

## Root cause

`src/codegen/class-bodies.ts:1222-1300` — default-value emission for method
parameters with initializers.

The flow is:
1. Allocate paramLocalIdx with the resolved `paramType` (e.g. `ref_null $vec_*`,
   `ref_null $iter_*`, or `externref` when TS couldn't resolve).
2. If `param.initializer` is present, compile it to `paramType` and emit a
   guarded `local.set` (line 1249) that fires when the param is null/undefined.
3. Then call `destructureParamArray` / `destructureParamObject`
   (`src/codegen/class-bodies.ts:1303-1311`).

The guard at step 2 uses `ref.is_null` (line 1275) for `ref` / `ref_null`
paramTypes and `__extern_is_undefined` (line 1264) for externref. The guard
**reads the local AFTER it was already initialised by the calling convention**,
which is the right place. However:

- For methods whose `paramType` was resolved to a concrete struct `ref_null`
  (vec or tuple), the call site receives `undefined` from JS and the param
  arrives as `ref.null $vec_*`. The guard fires correctly.
- The default initializer (`g()` or `{}`) is compiled to `paramType` — but
  `coerceType` from `externref` (the runtime type of `g()`) to a vec ref
  `ref_null $vec_*` falls through to the **guarded-cast branch**
  (`type-coercion.ts:1010-1048`) where `ref.test` against the vec type fails
  for an opaque generator externref and we emit `ref.null $vec_*` in the else.
- `local.set` then stores `null` into paramLocalIdx.
- `destructureParamArray` runs against the now-null local and hits its own
  `ref.is_null` guard → `buildDestructureNullThrow`.

So the default *appears* to be applied but is silently coerced to null because
neither `coerceType` nor `emitSafeStructConversion` know how to materialise an
externref iterable into a vec struct **in the default-application path** (the
fast path for actual params at the call site does use `__array_from_iter`).

## Implementation Plan

### Fix #1 (preferred) — Materialise externref → vec via `__array_from_iter`

**File: `src/codegen/type-coercion.ts`** — `coerceType` (line 951)

When `from.kind === "externref"` and `to` is `ref_null $vec_*` (or `ref $vec_*`),
materialise the externref through `__array_from_iter` + the vec
constructor pattern already used elsewhere (see `type-coercion.ts:206`,
`destructuring-params.ts:823`). Today this case falls through silently.

Add a branch near the top of `coerceType`:

```ts
if (from.kind === "externref" && (to.kind === "ref" || to.kind === "ref_null")) {
  const toIdx = (to as { typeIdx: number }).typeIdx;
  if (isVecTypeIdx(ctx, toIdx)) {
    emitExternrefToVec(ctx, fctx, toIdx);   // existing helper at line ~196
    return;
  }
}
```

`isVecTypeIdx` already exists in `type-coercion.ts`; `emitExternrefToVec`
factors out the conversion path from line 196 onward (already implements
`ref.is_null` early-return, length probe via `__extern_length`, element loop
via `__extern_get_idx`).

### Fix #2 (defensive) — Re-guard the destructure path

**File: `src/codegen/class-bodies.ts`** — line 1303-1311

After the param-default block sets the local, the value should never be
null/undefined (default applied). But because step 2 silently stores null on a
failed coercion, the destructure inherits the bug. Independent of Fix #1, the
destructure entry should **re-check the local** and (when the param had an
initializer with `dstrNullDefault === false`) re-emit the default into a temp
buffer that fires on null-after-default. This is a belt-and-braces safety net
the dev should add IF Fix #1 alone doesn't restore correctness:

```ts
for (let pi = 0; pi < member.parameters.length; pi++) {
  const param = member.parameters[pi]!;
  if (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name)) {
    // ... existing destructure call
  }
}
```

becomes guarded: emit destructure only after asserting the local is non-null.
For the externref destructure path this already runs (`emitExternrefDestructureGuard`
at `destructuring-params.ts:391`) — preserve current behaviour there.

### Wasm IR pattern

For Fix #1 (`coerceType` externref → vec):

```wasm
;; on stack: externref (the default's return value, e.g. g())
local.set $extTmp
local.get $extTmp
ref.is_null extern
if (result (ref null $vec_externref))
  ref.null $vec_externref      ;; default of default is null — destructure guard catches
else
  local.get $extTmp
  call $__array_from_iter      ;; externref → externref (materialised array)
  ;; then build vec struct via existing length/get-idx loop
end
```

The simpler shape: just `call $__array_from_iter` unconditionally; it already
handles null gracefully (returns `[]`).

### Edge cases

- Param default is the **literal** `null`/`undefined`: handled separately by
  the `dstrNullDefault` check at `class-bodies.ts:1240` (emits throw eagerly).
  Do not regress this.
- Param default returns a primitive (e.g. `method({} = 5)` — destructure
  primitive): per spec, ToObject is invoked. `__array_from_iter` returns an
  empty array for non-iterables, so this is **wrong** for object patterns; the
  object-binding-pattern destructure path uses `__extern_get` which already
  works on primitives via JS's `ToObject` boxing.
- Generator default (`= g()`): the destructure consumes via the iterator
  protocol. Make sure `__array_from_iter` is invoked exactly once (don't
  re-iterate when the destructure pattern is empty — `isPatternEmptyOnly`).
- Static methods (`isStatic === true`): param indexing uses `pi`, not `pi + 1`.
  Verify the existing logic at line 1226 is preserved.
- Private methods: lowered to `__priv_method` calls; the param-default emission
  should be the same path. Check `class-bodies.ts:1167-1300` is the right loop
  for private methods too (otherwise the bug repeats in a separate site).

### Test files to verify

Smoke tests after fix:
1. `test/language/statements/class/dstr/meth-dflt-ary-ptrn-elision.js` — array elision default
2. `test/language/statements/class/dstr/meth-dflt-ary-ptrn-elem-ary-elision-init.js`
3. `test/language/expressions/class/dstr/private-gen-meth-dflt-ary-ptrn-elision.js`
4. `test/language/statements/class/dstr/async-gen-meth-ary-ptrn-elem-ary-elision-init.js`

Run all `class/dstr/meth-dflt-*`, `gen-meth-*`, `async-gen-meth-*`,
`private-meth-*`, `private-gen-meth-*` via the test262 runner with a category
filter.

### Estimated impact

~134 official test262 fails should flip to pass (the `Cannot destructure` family
above). Possibly +10-15 secondary tests in the same dirs that hit the same
destructure path with non-default arguments and incidentally trip over null
materialisation.

## Acceptance criteria

- `new C().method()` for `method([,] = g())` returns normally
- `new C().method()` for `method({ x = 1 } = {})` returns `1`
- No regressions in `*/class/dstr/meth-*` baseline buckets
- `Cannot destructure 'null' or 'undefined' [in C_method() ← test]` error count
  in the latest test262 baseline drops by ≥100

## Related

- Parent: #820 (null/TypeError/illegal-cast umbrella)
- Sibling: #1543 (async-gen-meth dstr default → illegal cast)
- Sibling: #1544 (for-of/for-await-of dstr → illegal cast)
- Touches: `src/codegen/class-bodies.ts`, `src/codegen/type-coercion.ts`,
  `src/codegen/destructuring-params.ts`
