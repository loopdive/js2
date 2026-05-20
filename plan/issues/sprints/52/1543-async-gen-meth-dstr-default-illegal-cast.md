---
id: 1543
sprint: 52
title: "Async-generator method with destructured default params throws illegal cast instead of expected error"
status: ready
created: 2026-05-20
parent: 820
priority: high
feasibility: medium
goal: test262-conformance
test262_fail: 74
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

### Step 1 — Confirm the cast site

Compile the minimal repro with `--keep-name --debug` and inspect the emitted
wasm for the `async *method` body. The illegal cast will be at the `ref.cast
$vec_*` (or `ref.cast $struct_*`) immediately after the closure-env field
read. The dev should record the exact instruction sequence in this issue
before attempting the fix.

### Step 2 — Reorder: destructure BEFORE async-gen lifting

The cleanest fix is to **destructure the param into plain locals before the
async-gen state machine starts capturing**. The captured locals are the
post-destructure variables (`x`, `y`, ...), not the binding pattern source.

**File: `src/codegen/class-bodies.ts`** — method emission for `member.kind ===
ts.SyntaxKind.MethodDeclaration` with `member.asteriskToken` and
`member.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)`.

The current ordering (~line 1300+) is:
1. Emit param defaults
2. Emit destructure
3. Build async-gen state machine

This is correct in principle but the destructure step must produce **plain
locals** (already does for sync methods). Verify that for async-gen methods
the destructure outputs are captured into the closure env, not the
binding-pattern source struct.

If the destructure source struct (e.g. `[,] = g()` materialised into a vec
ref) is being captured by the closure env, **drop the source from the
capture set** — only the post-destructure identifiers need lifecycle into
the async state machine.

### Step 3 — Defensive: guard ref.cast with ref.test (#778 pattern)

If reordering doesn't fully eliminate the issue (e.g. some other site casts a
captured anyref), apply the `ref.test` guard pattern already used in
`coerceType` (`type-coercion.ts:1019-1048`):

```wasm
local.get $capturedAnyref
ref.test $expectedStruct
if (result (ref null $expectedStruct))
  local.get $capturedAnyref
  ref.cast_null $expectedStruct
else
  ;; throw appropriate TypeError, not wasm trap
  global.get $msg_cannot_destructure
  call $__throw_type_error
  unreachable
end
```

This converts the wasm trap into a JS-visible TypeError, which then **satisfies**
the test's `assert.throws(Test262Error, ...)` (since most of these tests are
checking that the initializer throws Test262Error, not the destructure itself).

### Wasm IR pattern

Outer method body:
```wasm
;; arg0 = method's first param (externref or struct ref)
local.get $arg0
ref.is_null
if (result externref)
  ;; param-default: evaluate `= {}` or `= g()`, materialise to expected vec/obj
  call $emitDefaultExpr
else
  local.get $arg0
end
local.set $patternSource

;; Destructure $patternSource INTO plain locals ($x, $y, ...) BEFORE state machine
;; (no closure capture of $patternSource itself)
... destructure ops, emit init expr if undefined ...

;; Then build async-gen closure capturing $x, $y, NOT $patternSource
ref.func $async_body_lifted
... closure env construct with $x, $y ...
```

### Edge cases

- The initializer expression itself can `throw` (e.g. `{ x = thrower() }`). The
  destructure must propagate that throw to the **outer caller** (not to the
  AsyncGenerator's promise), since these tests use `assert.throws` not
  `assert.throwsAsync`. Per spec the param-default evaluation happens in the
  function's lexical scope before the async body starts, so synchronous throw
  is correct.
- `unresolvable` reference in initializer (e.g. `{ x = undeclaredFn() }`) should
  produce a ReferenceError — verify error type after fix.
- Static and instance methods both need the fix; the lowering path is shared
  for `static async *method` and `async *method`.

### Test files to verify

Smoke:
1. `test/language/expressions/class/dstr/async-gen-meth-dflt-obj-ptrn-id-init-throws.js`
2. `test/language/expressions/class/dstr/async-gen-meth-dflt-obj-ptrn-id-init-unresolvable.js`
3. `test/language/expressions/class/dstr/async-gen-meth-dflt-ary-ptrn-rest-id-iter-step-err.js`

Then run all `async-gen-meth-dflt-*` and `async-gen-meth-static-dflt-*` via
test262 runner.

### Estimated impact

~74 official test262 fails should flip to pass. Possibly +10 secondary tests in
the same dirs where the cast was masking a real assertion path.

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
