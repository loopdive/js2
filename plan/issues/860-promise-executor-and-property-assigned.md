---
id: 860
title: "Promise executor and property-assigned functions not compiled as host callbacks"
status: done
completed: 2026-06-12
created: 2026-03-28
updated: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: high
goal: async-model
sprint: Backlog
branch: issue-860-callable-property-value
test262_fail: 1
---
# #860 -- Promise executor and property-assigned functions not compiled as host callbacks

## Problem

The test `test/built-ins/Promise/race/invoke-then.js` is listed in HANGING_TESTS. Investigation shows it currently errors at runtime rather than hanging (the behavior may have changed since the skip was added). The error is:

```
Promise resolver [object Object] is not a function
```

The test creates Promises with `new Promise(function() {})` and assigns custom `.then` methods to them. Both the executor function and the `.then` function are compiled as GC struct closures (opaque Wasm objects) instead of JS-callable functions.

### Test source (key lines)

```javascript
var p1 = new Promise(function() {});   // executor compiled as GC struct, not callable
var p2 = new Promise(function() {});
var p3 = new Promise(function() {});

p1.then = p2.then = p3.then = function(a, b) {
  // This function is assigned to a property on a Promise extern class object.
  // When Promise.race calls .then() internally, it needs to be JS-callable.
  assert.sameValue(typeof a, 'function');
  assert.sameValue(arguments.length, 2);
  assert.sameValue(this, currentThis);
  callCount += 1;
};

Promise.race([p1, p2, p3]);   // calls p1.then(...), p2.then(...), p3.then(...)
assert.sameValue(callCount, 3);
```

### Reproduction

```typescript
export function test(): number {
  var p = new Promise(function(resolve: any, reject: any) {
    resolve(42);
  });
  return 1;
}
// Runtime error: "Promise resolver [object Object] is not a function"
```

The compiled module has no `__make_callback` import and no `__cb_` exports, confirming that function expressions are not detected as host callback arguments.

## ECMAScript spec reference

- [§27.2.3.1 Promise(executor)](https://tc39.es/ecma262/#sec-promise-executor) — step 9: Call(executor, undefined, resolve, reject) — executor must be callable
- [§27.2.1.1 NewPromiseCapability](https://tc39.es/ecma262/#sec-newpromisecapability) — creates resolve/reject functions to pass to executor


## Root cause

**File**: `src/codegen/closures.ts`, function `isHostCallbackArgument` (line ~700).

The `isHostCallbackArgument` check determines whether a function expression should be compiled via the `__make_callback` host bridge (JS-callable) or as a GC struct closure (Wasm-internal only). It currently only detects function expressions passed as **direct arguments** to calls that target host imports.

Two patterns are missed:

### 1. `new Promise(executor)` -- constructor argument

`new Promise(function() {})` passes the executor to a `NewExpression`, not a `CallExpression`. The `isHostCallbackArgument` check only looks at `CallExpression` parents, so the executor is compiled as a GC struct closure. The host's `Promise_new` import receives an opaque struct object instead of a callable function, causing "Promise resolver [object Object] is not a function".

### 2. `obj.prop = function() {}` -- property assignment on extern class

`p1.then = function(a, b) { ... }` assigns a function expression to a property on an extern class instance. The function is compiled as a GC struct closure. When `Promise.race` later calls `p1.then(resolve, reject)` in the JS host, it gets the opaque struct object, which is not callable.

## Additional issues in this test

Even if the functions were compiled as host callbacks, the test also uses:
- `arguments.length` -- the `arguments` object inside a callback (requires special handling)
- `this` -- the `this` binding inside a callback called by the JS host
- `a.length` -- accessing `.length` on function parameters passed by the host

These may require additional work beyond just fixing the callback detection.

## Suggested fix

### For new expressions (executor pattern)

In `isHostCallbackArgument` (or a new check), detect when a function expression is an argument to a `NewExpression` whose constructor resolves to an extern class (e.g., `Promise`, `Map`, `Set`). Compile it via `__make_callback`.

Alternatively, add a special case in the `new Promise(executor)` compilation path in `expressions.ts` (line ~16189) to compile the executor as a host callback.

### For property assignment pattern

This is harder. When `p1.then = function(a, b) { ... }` is compiled, the RHS function expression is not a call argument -- it's the value in an assignment. The compiler would need to detect that the assignment target is a property on an extern class instance and use `__make_callback` for the RHS.

A simpler approach: when assigning a function expression to a property on any externref value, always compile it as a host callback. Functions assigned to extern properties are almost certainly intended to be called from the JS host.

## Complexity: M (<400 lines)

## Acceptance criteria

- [ ] `new Promise(function(resolve, reject) { resolve(42); })` works without error
- [ ] Function expressions assigned to extern class properties are JS-callable
- [ ] The test `Promise/race/invoke-then.js` passes (or at least doesn't hang/crash)
- [ ] Remove `Promise/race` entry from HANGING_TESTS in `tests/test262-runner.ts`

## Implementation Notes (dev-2)

### Change in `src/codegen/closures.ts`:

**`isHostCallbackArgument`** (~line 766): Extended to handle `NewExpression` parents in addition to `CallExpression`. When a function expression is an argument to `new SomeClass(fn)`:
- If `SomeClass_new` exists as a user-defined function in funcMap → NOT a host callback (use closure path)
- Otherwise (extern class like Promise, Map, etc.) → IS a host callback (use `__make_callback` path)

This fixes `new Promise(function(resolve, reject) { ... })` — the executor function is now compiled as a JS-callable callback via `__make_callback` instead of an opaque GC struct.

### Test results
- `new Promise(function(resolve, reject) { resolve(42); })` → PASS (was "Promise resolver [object Object] is not a function")
- `new Promise((resolve, reject) => { resolve(42); })` → PASS (arrow function variant)
- `new MyClass(() => 42)` (user class) → PASS (no regression, correctly uses closure path)
- Promise root-level test262 tests: 8 pass (up from ~0 for executor-related tests)
- `Promise/race/invoke-then.js` — no longer hangs, returns FAIL:2 (property assignment pattern is separate issue)

### Not addressed
- Property assignment pattern (`p1.then = function(a, b) { ... }`) — requires broader detection of externref property assignments. Filed as separate concern.

## Resolution (2026-05-28, dev) — property-value path

The property-assignment pattern is now fixed at the runtime side.
`__extern_set` (`p1.then = fn`) and `__defineProperty_value` (with a
data descriptor) both wrap the incoming value via a new
`_maybeWrapCallableUnknownArity(val, callbackState)` helper before
storing it on the host object.

The helper uses `__is_closure(val) === 1` as the authoritative
discriminator (so plain objects, vec wrappers, and named structs pass
through unchanged) and wraps the closure with the highest available
`__call_fn_<arity>` bridge (4 → 3 → ... → 0). The dispatcher already
drops extra args for lower-arity closures, so a single arity-agnostic
wrap is correct.

The fix is symmetric with the existing accessor path at
`__defineProperty_accessor`, which already used `_maybeWrapCallable`
on getter/setter values.

### Scope (broader than #860 originally framed)

This fix covers, in addition to `Object.defineProperty(o, k, { value: fn })`:

- `obj.foo = function() { ... }` (any extern object — Promise, real
  Array, plain JS object) — via `__extern_set` (`_safeSet`).
- `{ foo: function() { ... } }` object literals — `literals.ts`
  compiles each value property via `__extern_set`, which now wraps.
- Dynamic property writes on extern receivers — same path.

### Verified

- `tests/issue-860.test.ts` — 2 tests pass:
  - `Promise.race` invokes user-installed `.then` (counts call once).
  - `typeof arr.myFn === "function"` after `arr.myFn = function(){}`.
- `test262/built-ins/Promise/race/invoke-then.js` no longer fails at
  the "object is not a function" gate. New failure point is
  `assert.sameValue(this, currentThis)` (assertion #6) — the
  closure-bridge intentionally does not propagate `this` from the
  JS-side caller. Tracked as a separate phase (the issue's
  "Additional issues" section already noted this as out-of-scope).
- `tests/define-property-patterns.test.ts` — unchanged, all 9 pass.

### Out of scope for this PR

- `this` propagation through the closure-bridge wrapper (needed to
  fully pass `invoke-then.js`).
- `arguments` / `arguments.length` inside a closure invoked via the
  bridge — bridge currently only forwards positional args.
- Bridge identity: each wrap produces a fresh JS function. Protocols
  that observe `===` identity across host roundtrips would notice.
