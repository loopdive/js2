---
id: 3981
title: "Standalone `new` on a first-class function VALUE silently returns null — this is the cookie runtime-dynamic lane trap"
status: done
sprint: 78
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-01
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: classes
goal: standalone-gap
related: [2872, 3979]
# The construct DRIVER lives in its own subsystem module
# (src/codegen/native-construct.ts). What lands in the god-files is the
# irreducible wiring: the call-site recognizer in the `new` dispatcher, the
# two finalize hooks, and one context field.
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
  - src/codegen/index.ts
  - src/codegen/context/types.ts
# Same rationale per function. `compileNewExpression` gains the 4-line call-site
# recognizer; the two `generateModule*` finalize drivers gain the emit/fill
# hooks (the multi-file one also gains the `__call_fn_method_<N>` emission it
# was missing entirely); `createCodegenContext` gains one field initializer.
func-budget-allow:
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/context/create-context.ts::createCodegenContext
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

## Resolution

Fixed by a Wasm-native ordinary [[Construct]] — `src/codegen/native-construct.ts`
plus `tryCompileNativeConstructFromValue` in `new-super.ts`. One private driver
per call-site arity:

```
__native_construct_<N>(callee, proto, a0 … a<N-1>) -> externref
  if (proto == null) proto = __extern_get(callee, "prototype")
  self   = __object_create(proto)
  result = __call_fn_method_<N>(self, callee, a0 … a<N-1>)
  return IsObject(result) ? result : self
```

### The "missing `this` channel" was not missing

This issue recorded that there is "no existing call-a-closure-with-`this`
emitter". That was wrong: **`__call_fn_method_<N>` is exactly it** — it installs
the receiver into the `__current_this` module global across the inner
`call_ref`, which is how the constructor body's `this.x = …` reaches the fresh
instance. It was already emitted in standalone at arities 0–5 for the
`__apply_closure` / fnctor-prototype bridges; it had simply never been wired to
`new`. So the "separate effort" the two deferral comments in `new-super.ts`
point at was smaller than recorded.

### Three things the fix had to get right that were not obvious

1. **Placement — NOT inside the `!className` block.** The host bridge for this
   same case sits under `if (!className)`, but the checker frequently DOES give
   the callee an inferred symbol name: a JS `function F(){ this.x = 1 }` held in
   a `const` types `new C()` as `F`, which is not in `classSet`, so control
   skipped every arm and the whole expression fell out as **`undefined`** rather
   than null. The native path therefore runs after the class and fnctor arms
   have declined, where it sees both shapes.
2. **The prototype lives in two places.** A `F.prototype = …` write that
   `resolveUserFnctorName` recognises is intercepted by #2660 S2 into the
   per-fnctor module global; everything else lands in the closure own-property
   side table (#3468). Reading only one left the instance unlinked and every
   inherited read undefined, so the call site supplies the global when it
   resolves and the driver falls back to `__extern_get` otherwise.
3. **`__typeof_object(null)` is 1** (JS `typeof null === "object"`). Folding
   null into the return-an-object probe would return null out of `new` —
   reinstating this exact bug. The null test is separate and first.

### A second, worse bug the first attempt introduced

The multi-file finalize path (`compileMulti`, which is how every npm dogfood
lane compiles) emits only `__call_fn_0`/`__call_fn_1` — **never** the
`__call_fn_method_<N>` dispatchers the single-module path emits at 0–5. So the
reserved driver had nothing to fill it with and shipped its bare `unreachable`
stub: the cookie lane went from a catchable "property of null" to an
**uncatchable Wasm trap**. The multi path now emits the dispatchers up to the
arity a driver actually reserved, so a module with no such site is byte-identical.
This is the same class of gap the `fillArrayToPrimitive`/`fillClassToPrimitive`
comment directly above it already documents.

### Verified

- `cookie`'s `standalone · runtime dynamic` lane: `runtime-error` → **`measured`**
  (ratio ≈ 0.099).
- `tests/issue-3981-standalone-construct-function-value.test.ts` — 14 cases, each
  asserted against the SAME source evaluated by Node, covering all three
  null-returning shapes from the table, own-property write/read, body execution
  with bound `this`, argument order/count, the three §10.2.2 return cases, and
  the cookie shape end to end. Plus a zero-host-imports assertion.

## Follow-up NOT fixed here: an object-LITERAL prototype is not an `$Object`

`__object_create(proto)` links `$proto` only when `proto` passes
`ref.test $Object`. A plain object literal compiles to a closed struct, not an
`$Object`, so `F.prototype = { greet: 11 }` on a value-bound constructor
produces an instance with a null `$proto` and `new C().greet` is undefined. A
`Object.create(null)`-built prototype works, which is why cookie passes.

This is a **prototype-storage** gap, not a construct gap, and it is independent
of this issue: it reproduces on the pre-existing function-declaration path on
main too — `function F(){ this.x = 3 }; F.prototype = { y: 4 }; const o = new F();
o.x + o.y` is `NaN` both before and after this change. Only #2660 S2's
escape-gate-approved interception converts such a literal into an `$Object`, and
that gate's own comment records that widening it unscoped previously cost −40 on
the standalone floor. It therefore needs its own scoped issue rather than being
bolted on here.

## Why this was not fixed at filing time

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

- [x] `new` on a first-class function value constructs a real object in
      standalone/WASI, matching the JS-host lane.
- [x] Property assignment and read on that instance work (the second defect
      above).
- [x] All seven rows in the table match native.
- [x] `cookie`'s `standalone · runtime dynamic` lane reports `measured`.
- [x] An equivalence test covers `new` through a const alias, through a
      function return value, and through an IIFE.
