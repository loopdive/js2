---
id: 1543
title: "Async-generator method with destructured default params throws illegal cast instead of expected error"
status: ready
created: 2026-05-20
spec_done: 2026-05-20
parent: 820
priority: high
feasibility: medium
goal: test262-conformance
test262_fail: 74
shares_fix_with: [1544]
root_cause_doc: 1556
note: "Line numbers verified against main 2026-05-21: literals.ts:447 (binding-element exclusion) and destructuring-params.ts:620 (default-value check) both confirmed present and unchanged"
---

# #1543 — Async-gen-meth destructured default param → illegal cast

## Problem

Async generator methods (`async *method({ x = expr() } = {}) {}`) called from
`assert.throws(Test262Error, () => method())` consistently produce

```
L68:3 illegal cast [in __closure_3() ← assert_throws ← test]
L68:3 illegal cast [in __closure_4() ← assert_throws ← test]
```

instead of the *expected* error the test is probing for (e.g. a `Test262Error`
thrown from the initializer, or a TypeError from destructuring `null`).

The illegal cast happens **inside the lifted closure that wraps the
async-generator body**, before the destructure expression's spec-compliant
exception path can fire. This means the test reports a wasm trap, not a JS
TypeError/Test262Error, and the `assert.throws` check fails.

### Minimal repro

```js
function thrower() { throw new Test262Error(); }
var C = class { async *method({ x = thrower() } = {}) {} };
var method = C.prototype.method;
assert.throws(Test262Error, function() { method(); });
// expected: Test262Error from thrower()
// actual:   wasm "illegal cast" inside the async-gen state machine
```

### Test262 coverage (~74 official fails)

All under `language/{statements,expressions}/class/dstr/`:

- `async-gen-meth-dflt-obj-ptrn-id-init-throws.js`
- `async-gen-meth-dflt-obj-ptrn-id-init-unresolvable.js`
- `async-gen-meth-dflt-obj-ptrn-prop-id-init-throws.js`
- `async-gen-meth-dflt-obj-ptrn-prop-eval-err.js`
- `async-gen-meth-dflt-obj-ptrn-prop-id-get-value-err.js`
- `async-gen-meth-dflt-ary-ptrn-elem-id-init-unresolvable.js`
- `async-gen-meth-dflt-ary-ptrn-rest-id-iter-step-err.js`
- `async-gen-meth-dflt-ary-init-iter-get-err.js`
- `async-gen-meth-static-dflt-*` variants (mirror set)

Bucket counts from latest baseline:
- `L68:3 illegal cast [in __closure_3() ← assert_throws ← test]`: 24
- `L68:3 illegal cast [in __closure_4() ← assert_throws ← test]`: 24
- `L71:3 illegal cast [in __closure_3() ← assert_throws ← test]`: 7
- `L71:3 illegal cast [in __closure_4() ← assert_throws ← test]`: 6
- `L76:3 illegal cast [in __closure_4() ← assert_throws ← test]`: 4
- `L73:3 illegal cast [in __closure_4() ← assert_throws ← test]`: 4
- Long-tail variants: ~5 more

## Root cause hypothesis

Async generator methods are lowered to a two-step state machine:
1. The user's body is hoisted into a closure that suspends on `await` / `yield`.
2. The async generator runtime returns an externref AsyncGenerator object.

When the method has a destructured default param, the destructure code is
emitted into the **outer body** (before the state machine resumes). That outer
body runs with the wasm async-gen closure context, so any cast that succeeds
in a regular method body (where the destructure source is on the stack as a
concrete struct) **fails inside the closure** because the source value has been
moved into the closure environment and re-typed as `anyref` / `eqref` /
`externref`.

Specifically: the destructure entry path expects the source to be the param's
declared type (e.g. `ref_null $vec_*`), but in the lifted closure the param is
captured via a `struct.get` from the closure env (which returns `anyref` or
`externref`) and the subsequent `ref.cast` to the declared param type traps
because the runtime value is the unrelated default object/array struct.

The same shape compiles correctly for sync methods (cluster #1542) because the
destructure runs against the param local directly, not against a captured copy.

### Where to look

- `src/codegen/declarations.ts` — async generator function lowering; search for
  the closure capture loop that builds the env struct
- `src/codegen/class-bodies.ts:1303-1311` — destructure call for class methods;
  this loop runs **before** the body is lifted into the async-gen state machine
  for `async *method`, but the lifted closure may re-execute the destructure
- `src/codegen/destructuring-params.ts:391` (`emitExternrefDestructureGuard`)
  and `:651` (`destructureParamArray`) — the ref.cast site

Grep target: `async *method` lowering path, look for the closure-env capture
of param locals before destructure emission.

## Implementation Plan

> **Supersedes** the prior "destructure-before-async-gen-lifting" plan.
> Root-cause analysis in #1556 shows the illegal cast is **not** caused by
> async-gen closure capture — sync methods, async-gen methods, and for-of
> rest patterns all share the same underlying defect: binding-pattern
> parameter `{}` (and `[]`) defaults emit as **typed structs whose field
> types do not match the binding locals' declared types**. The async-gen
> closure wrapping is what masks the compile-time validation error into a
> runtime trap inside `__closure_3 / __closure_4`. Fix the param-default
> path and the closure manifestation disappears.
>
> See **#1556** for the full root-cause writeup. This plan is shared with
> **#1544**; both issues will be closed by the same patch.

### Architectural decision: Path B (narrowed) + Path D (defensive)

Of the three paths in #1556:

- **Path A** (widen all binding-pattern struct field types to externref):
  spec-correct but invasive — requires sibling-struct registration and
  rerouting param wasm types. ~200 lines.
- **Path B** (remove `literals.ts:447` binding-element exclusion): the
  exclusion was added in commit `67c59de60` (2026-04-11, fix(#929) CI
  regressions) **before** the safe `ref.test` / `__extern_get` fallback
  was added to `destructureParamObject` in #852 (lines 489–521). With the
  fallback in place, the 150-regression scenario the exclusion guarded
  against no longer applies — the externref path now safely covers it.
  **~10 lines.**
- **Path C** (ref.test guards): only fixes runtime traps; insufficient
  for the compile-time validation error this same root cause produces in
  the sync-method shape (issue #1556's *Shape 1*).

**Chosen approach**: a hybrid of **B (primary)** and **D (defensive
coercion)**, with **Path C ref.test guards already present** in the
externref path serving as the safety net Path B relies on. Path A is held
in reserve if Path B regresses any of the 150 historical cases.

### Why Path B is now safe (audit of the "150+ regressions" claim)

The 2026-04-11 commit comment says "ref.test for the struct type fail and
null-deref." That was true at the time: `destructureParamObject` had only
one path — `ref.cast` the externref to the expected struct, no `ref.test`
guard. When `__new_plain_object()` was passed in, the cast trapped.

In commit `9d82b4e2d` ("PR #177" / #852), `destructureParamObject` was
rewritten to (a) `ref.test` first, (b) take the struct fast path when
true, (c) fall back to `destructureParamObjectExternref` which uses
`__extern_get` per-field. The 150-regression scenario the exclusion
guarded against is now caught by step (c).

Audit confirmation:

```
src/codegen/destructuring-params.ts:489-521
  // Use ref.test to check if the value is the expected struct (safe for primitives)
  ...
  fctx.body.push({ op: "if", ..., then: thenInstrs, else: elseInstrs });
```

The `else` branch routes to `destructureParamObjectExternref` (line 514),
which calls `__extern_get` per property — JS getters fire, missing
properties yield `undefined` (so defaults fire), null/undefined sources
throw the spec-mandated TypeError via `emitExternrefDestructureGuard`.

The dev should validate the audit empirically: run the regression gate
before pushing.

### Changes

#### Primary fix — `src/codegen/literals.ts:447`

**Function**: `compileObjectLiteral`
**Current** (line 447):

```ts
if (expr.properties.length === 0 && !ts.isParameter(expr.parent) && !ts.isBindingElement(expr.parent)) {
```

**Change to**:

```ts
if (expr.properties.length === 0) {
```

Update the stale comment block (lines 442–446) — strike the
"binding-element exclusion" rationale and reference this issue + #1556.

That single character of code removes the carve-out. The downstream
contextual-type check (`isAnyContext`) at lines 451–456 still gates the
`__new_plain_object` route only when the contextual type is `any` /
`unknown` / `object` — which it WILL be for binding-pattern defaults
without an explicit annotation (`function f({ x } = {})`), and WON'T be
when the param has an explicit typed annotation (`function f({ x }:
Point = {})` — there the contextual type is `Point`, the struct path
fires as before).

This is the **narrowed** Path B: not "always externref for binding
patterns" but "let the existing contextual-type heuristic decide,
removing only the artificial binding-element block."

#### Defensive fix — `src/codegen/destructuring-params.ts:620`

**Function**: `destructureParamObject` (struct fast path, ~line 619–628)
**Current**:

```ts
if (element.initializer) {
  emitDefaultValueCheck(ctx, fctx, fieldType, localIdx, element.initializer);
} else {
  const objLocalType = getLocalType(fctx, localIdx);
  if (objLocalType && !valTypesMatch(fieldType, objLocalType)) {
    coerceType(ctx, fctx, fieldType, objLocalType);
  }
  fctx.body.push({ op: "local.set", index: localIdx });
}
```

**Change to**:

```ts
const objLocalType = getLocalType(fctx, localIdx);
if (element.initializer) {
  emitDefaultValueCheck(ctx, fctx, fieldType, localIdx, element.initializer, objLocalType);
  //                                                                         ^^^^^^^^^^^^^
  // Pass targetType so emitDefaultValueCheck coerces fieldType → localType
  // on both the "value present" and "default fires" branches. Without this,
  // mismatched primitive struct fields write i32/f64 into externref locals
  // (compile-time Wasm validation error: "expected externref, found i32").
  // See emitDefaultValueCheck signature at statements/destructuring.ts:297.
} else {
  if (objLocalType && !valTypesMatch(fieldType, objLocalType)) {
    coerceType(ctx, fctx, fieldType, objLocalType);
  }
  fctx.body.push({ op: "local.set", index: localIdx });
}
```

Why both fixes: Path B routes the common `{}` default through externref,
which eliminates the field-type mismatch at its source. The defensive
coercion in `emitDefaultValueCheck` covers any residual cases where the
contextual-type heuristic still picks the typed-struct path (explicitly
annotated patterns, nested binding elements) and a field type happens to
disagree with its destination local.

**Symmetric fix — `src/codegen/destructuring-params.ts:1115`**

`destructureParamArray` tuple path calls `emitNestedBindingDefault`
rather than `emitDefaultValueCheck`, but does compute `effType = localType
|| fieldType` and pass it through; verify that `emitNestedBindingDefault`
honours the target type the same way. If not, mirror the targetType
plumbing.

#### Path C ref.test guards — already present, no new code

The runtime "illegal cast inside __closure_3" symptom is what happens
when the compile-time validation passes (because the closure boundary
widens to externref) but the inner cast traps. With Path B + D removing
the underlying mismatch, the trap site is unreachable. No new guards
needed. Existing `ref.test` paths in `coerceType` and
`destructureParamObject:489-521` remain as the safety net.

### Wasm IR change (conceptual)

**Before** (typed-struct path, broken):

```wasm
;; param 0: ref $anonStruct (with field x : i32)
;; arg = {} default — synthesized as struct.new_default $anonStruct
;; (field x default = i32.const 0)
local.get 0
struct.get $anonStruct $x          ;; pushes i32 0
local.set $x_local                 ;; $x_local declared externref → VALIDATION ERROR
```

**After Path B** (externref path):

```wasm
;; param 0: ref $anonStruct (signature unchanged — function-body.ts still
;; resolves typed-struct from getTypeAtLocation; only the {} default emission changes)
;; arg = {} default — synthesized as call $__new_plain_object → externref

;; destructureParamObject sees param type ref/ref_null → struct fast path
;; ref.test against $anonStruct: arg is a JS plain object, not the wasm struct → FALSE
;; falls through to destructureParamObjectExternref:

local.get 0
extern.convert_any                  ;; (or skip: param is ref, route via anyref)
;; ... __extern_get(arg, "x") returns externref undefined since property absent ...
local.tee $tmp_x
ref.is_null                         ;; (or __extern_is_undefined)
if
  call $thrower                     ;; default fires correctly
  local.set $x_local
else
  ;; coerce externref → declared local type, then local.set
end
```

### Edge cases to verify

- **Explicit typed annotation**: `function f({ x }: { x: number } = {})` —
  contextual type of `{}` is `{ x: number }`, NOT `any`, so the
  `isAnyContext` gate at literals.ts:451–456 still routes through the
  typed-struct path. Behaviour unchanged. ✓
- **Nested binding patterns**: `function f({ a: { b = 1 } = {} } = {})` —
  inner `= {}` parent is BindingElement (now allowed through B). The inner
  default `{}` is contextual-typed by the outer pattern's field type;
  same `isAnyContext` gate decides. ✓
- **Array-pattern defaults**: `function f([a = 1] = [])` — `compileArrayLiteral`
  has its own emission path; verify it has no parallel binding-pattern
  exclusion. (Spec note: there is no `[]`-equivalent of `literals.ts:447`;
  no change needed for the empty-array default.)
- **Initializer with side effects** (`{ x = thrower() }`):
  `__new_plain_object()` is empty, `__extern_get(_, "x")` returns
  undefined → default fires → `thrower()` runs → throws Test262Error →
  test passes. ✓ (Confirms #1542 overlap: "default not fired" was a
  consequence of the same type mismatch swallowing the undefined check.)
- **`unresolvable` reference in default** (`{ x = undeclared() }`):
  `compileExpression` of `undeclared()` is the same regardless of which
  path emits the call; spec-compliant ReferenceError is unaffected.
- **Static and instance class methods**: both go through
  `class-bodies.ts:1303–1311` → `destructureParamObject/Array`; same fix
  covers both.
- **Async generator methods**: the closure wrapping that produced
  `__closure_3 / __closure_4` traps captures the post-destructure
  locals. With the struct.get/local.set mismatch removed at the param
  destructure site (which runs BEFORE the async-gen state machine
  starts), the closure body has nothing left to trap on.

### Regression gate

Run the dstr family that the `literals.ts:447` exclusion was originally
protecting:

```bash
pnpm run test:262 -- --filter "language/destructuring/"
pnpm run test:262 -- --filter "language/statements/for-of/dstr/"
pnpm run test:262 -- --filter "language/statements/for-await-of/"
pnpm run test:262 -- --filter "language/statements/class/dstr/"
pnpm run test:262 -- --filter "language/expressions/class/dstr/"
pnpm run test:262 -- --filter "language/expressions/function/dstr/"
pnpm run test:262 -- --filter "language/expressions/arrow-function/dstr/"
```

Compare pass counts before/after on each of the seven dirs. If any dir
regresses **at all** (net negative), Path B is not safe alone — fall back
to **Path A** (sibling-struct registration with widened externref fields)
which is described in #1556. The architect signal-of-fallback: any single
dstr/* dir with `net < 0` after the patch.

CI gate via `dev-self-merge` skill: `net_per_test > 0` overall, no single
test-path bucket > 50 regressions.

### Test files to verify (smoke before push)

Each should compile AND produce a JS-level error (Test262Error /
ReferenceError / TypeError), NOT a wasm "illegal cast" trap:

1. `test/language/expressions/class/dstr/async-gen-meth-dflt-obj-ptrn-id-init-throws.js`
2. `test/language/expressions/class/dstr/async-gen-meth-dflt-obj-ptrn-id-init-unresolvable.js`
3. `test/language/expressions/class/dstr/async-gen-meth-static-dflt-obj-ptrn-id-init-throws.js`
4. `test/language/expressions/class/dstr/async-gen-meth-dflt-ary-ptrn-rest-id-iter-step-err.js`
5. `test/language/expressions/class/dstr/async-gen-meth-dflt-obj-ptrn-prop-id-get-value-err.js`

Local scoped run:

```bash
# Pick 3 representative tests as quick smoke
node tests/test262-runner.ts \
  --filter "async-gen-meth-dflt-obj-ptrn-id-init-throws|async-gen-meth-dflt-ary-ptrn-rest-id-iter-step-err"
```

### Complexity estimate

- Path B (literals.ts:447 narrowing): **~5 lines**, including comment update.
- Path D (destructuring-params.ts:620 targetType plumbing): **~3 lines**.
- Symmetric tuple-path verification (destructuring-params.ts:1115):
  **~5 lines** if `emitNestedBindingDefault` needs the same fix.

**Total ~15 lines** for the primary fix. If Path B regresses, fall back
to Path A which is **~150–200 lines** (sibling-struct registration in
`ensureStructForType`, threading through `function-body.ts` param-type
resolution).

### Shared with #1544

#1544's for-of dstr rest/elision cluster is the **same root cause** in a
different framing: for-of array-pattern destructuring of iterator results
where the inferred element type carries a struct shape with primitive
fields. The fix path is identical (B+D) — the for-of array path at
`statements/loops.ts:990+` ultimately routes through the same
`destructureParam*` machinery once the iterator value is materialised
into a vec.

**However**: for #1544 also verify the for-of *iteration source* itself.
If the iterable is a plain JS object with `[Symbol.iterator]` (not a vec
or tuple struct), the for-of statement currently routes through
`compileForOfIterator` (loops.ts:1740) — that path must reach
`compileExternrefArrayDestructuringDecl` for `[...rest]`. Cross-check
that the iterator-protocol entry doesn't `ref.cast` the source before
the externref destructure handler is invoked. If it does, add a
`ref.test` guard there as well (Path C complement). See #1544's plan
section for the exact callsite to audit.

## Acceptance criteria

- `async-gen-meth-dflt-obj-ptrn-id-init-throws.js` and family pass
- `L68:3 illegal cast [in __closure_3() ← assert_throws ← test]` count drops to
  ≤5 in latest baseline
- No regressions in `async-gen-meth-*` (non-dflt) bucket

## Related

- Parent: #820 (null/TypeError/illegal-cast umbrella)
- Sibling: #1542 (sync class method dstr default not applied)
- Sibling: #1544 (for-of/for-await-of dstr → illegal cast)
- Related: #778 (ref.test before ref.cast guard pattern)
- Related: #826 (illegal-cast umbrella follow-up)
