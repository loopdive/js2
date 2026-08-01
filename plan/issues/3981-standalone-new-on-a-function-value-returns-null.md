---
id: 3981
title: "Standalone `new` on a first-class function VALUE silently returns null — this is the cookie runtime-dynamic lane trap"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: classes
goal: standalone-gap
related: [2872, 3979]
---

# Standalone `new` on a function value returns null

## Problem

The `cookie` package's `standalone · runtime dynamic` perf lane has been failing
with:

```
TypeError: Cannot access property on null or undefined at 14:17
phase: checksum
```

Line 14 column 17 of the generated driver is `parsed.a`, so `parseCookie(...)`
returned null. It cannot: `parseCookie` returns `new NullObject()`, and its only
early exit returns that same object.

```js
const NullObject = /* @__PURE__ */ (() => {
  const C = function () {};
  C.prototype = Object.create(null);
  return C;
})();

export function parseCookie(str, options) {
  const obj = new NullObject();
  ...
  return obj;
}
```

**`new NullObject()` evaluates to null in standalone builds.** The diagnosis is
not "a runtime-built string breaks parsing" — that was the misleading surface,
because the lane that works passes a string LITERAL. The literal lane only
survives because of the exact driver shape it happens to have; the constructor
is broken either way.

## Root cause — exact location

`src/codegen/expressions/new-super.ts:2654`, the unknown-constructor base of the
dynamic `new` tag-dispatch chain:

```ts
} else if (noJsHost(ctx) && !useRuntimeArgv) {
  // (#2872) Standalone/WASI unknown-ctor base: the runtime value may be a
  // first-class `$__ta_ctor` ...
  // Route through the runtime-gated general TA construct; any other runtime
  // value keeps the pre-existing null-extern outcome (the ref.test declines).
  emitTaDynCtorConstructFromLocals(ctx, fctx, descLocal, argLocals);
```

When the callee is not a compiled class tag and not a TypedArray constructor,
the `ref.test` declines and the arm falls through to `ref.null.extern`. A plain
function value is exactly that case, so `new F()` produces **null with no trap
and no diagnostic**.

The adjacent branch already states the right principle for its own case:

```ts
} else if (noJsHost(ctx) && useRuntimeArgv) {
  // A runtime value that matches no compiled class tag has no [[Construct]].
  // Throw a real, catchable TypeError in host-free targets instead of
  // silently returning null.
```

— but that only covers the runtime-argv shape. The fixed-argc shape (`new F()`,
which is what cookie emits) still silently nulls.

## Measured

Standalone, `optimize: 4`, `deferTopLevelInit: true`. `-1` means the constructed
value was `=== null`.

| program                                                       | result |
| ------------------------------------------------------------- | ------ |
| `function F(){}; new F()`                                      | ok     |
| `const C = (() => class {})(); new C()`                        | ok     |
| `const F = function(){}; const C = F; new C()`                 | **null** |
| `function mk(){ return function(){} } const C = mk(); new C()` | **null** |
| `const C = (() => function(){})(); new C()`                    | **null** |
| `const C = (() => { const F = function(){}; F.prototype = Object.create(null); return F; })(); new C()` | **null** |
| same, but `F.prototype = {}`                                   | ok     |

So `new` works when the callee is a statically-resolvable **function
declaration** or **class**, and fails whenever the constructor arrives as a
first-class **value**. The JS-host lane is unaffected — it reaches
`__construct_closure`, whose `Reflect.construct` probe handles any runtime value.
That is why `cookie`'s `jsHost` lane measures and only `standalone` breaks.

## A second, separate defect sits behind it

Even in the shape that does NOT return null, the instance is wrong:

```js
const NullObject = function () {};
NullObject.prototype = Object.create(null);
// new NullObject() → non-null, but:
o["a"] = "1"; o["a"] === "1"   // → false in standalone
```

So fixing the null alone will not make `parseCookie` work. Both need to land
before cookie's dynamic lane can pass.

## Why this was not fixed here

The correct fix is a **Wasm-native dynamic Construct**: allocate a fresh object
whose prototype is the callee's `.prototype`, invoke the callee with `this`
bound, and honour the return-an-object rule. `new-super.ts` explicitly defers
that twice — "a Wasm-native dynamic Construct of `this` is a separate effort"
(line 3562) and again at line 3719 — and there is no existing
call-a-closure-with-`this` emitter to build it from
(`emitClosureCallArgcExtras`, `emitTaDynCtorConstructFromLocals` and friends
have no `this` channel).

**Do not "fix" this by making the null a thrown TypeError.** The lane would go
from "null property access" to "is not a constructor" and still fail; a
construction that JavaScript defines as succeeding must succeed. Same standard
as #3979.

## Reproduction

```bash
npx tsx scripts/generate-npm-compat-report.mjs --only cookie --no-write --perf-only
# → standaloneDynamic: runtime-error, phase "checksum"
```

Minimal, no cookie involved:

```js
const C = (() => { const F = function () {}; return F; })();
export function probe() { return new C() === null ? -1 : 1; }
// standalone: -1     node: 1
```

## Acceptance criteria

- [ ] `new` on a first-class function value constructs a real object in
      standalone/WASI, matching the JS-host lane.
- [ ] Property assignment and read on that instance work (the second defect
      above).
- [ ] All seven rows in the table match native.
- [ ] `cookie`'s `standalone · runtime dynamic` lane reports `measured`.
- [ ] An equivalence test covers `new` through a const alias, through a
      function return value, and through an IIFE.
