---
id: 1551
sprint: 52
title: "spec gap: SuperCall — argument-list evaluation order, spread getter side-effects, uninitialized-this PutValue"
status: ready
created: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, super, spread
goal: spec-completeness
parent: 779
related: [1455, 1456]
note: "Verified 2026-05-21: compileSuperPropertyAccess at new-super.ts:258, compileSuperCall at class-bodies.ts:1629. No src/codegen/expressions/object.ts file exists — that ref was speculative."
---
# #1551 — `super(...)` / `super[expr]` evaluation order and abrupt-completion handling

## Problem

`language/expressions/super/` has **64 still-failing** assertion tests in the
May 2026 baseline. These exercise the §13.3.7 / §13.3.5 specifications for
`SuperCall`, `SuperProperty`, and the uninitialized-`this` reference rules.
Concretely:

1. **ArgumentListEvaluation abrupt completion**
   `call-arg-evaluation-err.js`:
   ```js
   var thrown = new Test262Error();
   class C extends Object {
     constructor() {
       try { super(thrower()); } catch (err) { caught = err; }
     }
   }
   new C();
   assert.sameValue(caught, thrown);
   ```
   We currently swallow / replace the thrown value (probably catching it
   inside the implicit super-call lowering and rethrowing a different
   `Test262Error`-shaped object, or never propagating it because the
   `super()` call wrapper has its own try/catch).

2. **Spread argument getter side-effects**
   `call-spread-obj-getter-init.js`:
   ```js
   class P { constructor(obj) { /* assertions on obj */ } }
   class C extends P {
     constructor() {
       super({...o, get c() { executedGetter = true; }});
     }
   }
   ```
   We pass a wrong-shape object to the super constructor, or evaluate the
   getter (executedGetter ends up true) when it shouldn't — the test
   passes the object as-is.

3. **Uninitialized-this PutValue**
   `prop-expr-uninitialized-this-putvalue.js`,
   `prop-expr-uninitialized-this-putvalue-increment.js`:
   ```js
   class Derived extends Base {
     constructor() { super[super()] = 0; }   // ReferenceError before Base throws
   }
   assert.throws(ReferenceError, () => new Derived);
   ```
   Spec §13.3.7.1 requires that `super[expr]` (PutValue context) throws
   `ReferenceError` if `this` is uninitialized — *before* evaluating the
   expression / RHS. We don't emit this guard, so the test sees `Test262Error`
   from the base constructor or nothing at all.

4. **`GetSuperBase` before `ToPropertyKey`**
   `prop-expr-getsuperbase-before-topropertykey-getvalue.js`:
   §13.3.7.3: `Let baseValue be ? actualThis.[[GetPrototypeOf]]()` happens
   **before** `ToPropertyKey(propertyNameValue)`. We may reorder these.

5. **`prop-expr-cls-key-err.js`** — `super[expr]` where the key expression
   throws: the original error must propagate, not a Wasm trap or wrapped
   exception.

## Failure count

**64** `assert_fail` rows under `test/language/expressions/super/`:

| Pattern | Count | Driver |
| --- | --- | --- |
| `call-spread-*` | ~25 | spread-arg getter / iterator semantics in SuperCall |
| `call-arg-evaluation-err` | 1 | ArgumentList abrupt completion propagation |
| `prop-expr-uninitialized-this-*` | ~6 | uninitialised-this ReferenceError before LHS/RHS |
| `prop-expr-cls-key-err` | 1 | key expression throws |
| `prop-expr-getsuperbase-before-*` | 2 | step ordering |
| `call-spread-mult-literal` etc. | ~15 | multiple-arg spread expansion |
| others | ~14 | misc |

## Root cause

In `src/codegen/expressions/new-super.ts` (and related super-call lowering in
`src/codegen/class-bodies.ts`):

1. **Implicit catch around `super(...)`** — the externref-backed subclass
   constructor probably wraps the parent `__new_<Parent>(...)` call in a
   try/catch to install the tag chain (see #1455). If `ArgumentListEvaluation`
   throws **before** the call, we likely still enter the catch (because the
   wrapper spans both the arg evaluation and the call). The catch should
   only span the call itself.

2. **Spread argument lowering** — `compileSpreadElement` for the argument
   list of `super(...)` may iterate object spreads via a different path
   than ordinary `[...obj]` array spreads (covered by #1454). For SuperCall
   args, the spread is `...{...obj}` (CopyDataProperties), which must
   honour getter accessors as data properties without invoking them. Verify
   the path used (`__copy_data_properties` vs raw enumeration).

3. **Uninitialized-this guard** — `compileSuperProperty` (and
   `compileSuperCall`) needs to emit, at the top:
   ```wasm
   local.get $this_ref
   ref.is_null   ;; or check __this_initialized flag
   if
     ;; throw new ReferenceError("super property access before super()")
   end
   ```
   This guard must run **before** the index expression is evaluated. Today
   we likely evaluate `expr` first, then crash or read garbage.

4. **`GetSuperBase` ordering** — fixed by moving the `GetPrototypeOf(this)`
   call (or its precomputed equivalent) before the `ToPropertyKey` call.

## Acceptance criteria

1. `test/language/expressions/super/call-arg-evaluation-err.js` passes —
   the original thrown value (`Test262Error` instance reference equality)
   reaches the user catch.
2. `test/language/expressions/super/call-spread-obj-getter-init.js` passes —
   `executedGetter` stays `false` after the super call (getter copied as
   accessor descriptor, not invoked).
3. `test/language/expressions/super/prop-expr-uninitialized-this-putvalue.js`
   passes — `ReferenceError` thrown before the inner `super()` is invoked.
4. `test/language/expressions/super/prop-expr-uninitialized-this-putvalue-increment.js`
   passes.
5. `test/language/expressions/super/prop-expr-cls-key-err.js` passes —
   the key expression's thrown value propagates unchanged.
6. `test/language/expressions/super/prop-expr-getsuperbase-before-topropertykey-getvalue.js`
   passes.
7. `test/language/expressions/super/call-spread-mult-literal.js` passes.
8. `expressions/super/` `assertion_fail` count reduces by **≥ 50**.
9. `tests/issue-1551.test.ts` with one focused case per acceptance bullet.

## Implementation plan

### Step 1 — narrow the super-call try/catch

In `src/codegen/class-bodies.ts` (externref-backed subclass implicit
super), restructure the emission so the try/catch spans *only* the
`__new_<Parent>(...)` call and the `__tag_user_class(...)` follow-up.
ArgumentList evaluation must throw out through the user constructor.

### Step 2 — emit uninitialized-this guard for SuperProperty

In `compileSuperProperty` (or wherever `MemberExpression : super [ E ]`
is lowered) emit a guard at the very top, before the index expression is
evaluated:

```ts
// pseudo-code
emit(Op.local_get, ctx.thisLocalIdx);
emit(Op.ref_is_null);
emit(Op.if, { result: 'i32' });
  emitThrowReferenceError("Must call super constructor before accessing 'super'");
emit(Op.end);
// only NOW evaluate the index expression
```

For PutValue context (`super[e] = v`), repeat the guard — the spec runs
PutValue's reference resolution first, which is what throws.

### Step 3 — reorder GetSuperBase before ToPropertyKey

In `compileSuperProperty`:
- Compute `GetSuperBase()` first (call `__get_prototype_of(this)` or
  the static equivalent).
- Then evaluate the property name expression.
- Then `ToPropertyKey` it.

This matches §13.3.7.3 exactly. The fix is small (swap two emission
blocks).

### Step 4 — spread in super arguments

Verify that `super({...o, get c(){}})` uses `__copy_data_properties` on
`o` (which enumerates own-enumerable string keys and reads values) plus
a getter accessor descriptor for `c`. The getter must not be invoked
during the spread — only installed. Cross-check with
`compileObjectExpression` for non-super positions; the same lowering
should be reused. If `super(...)` has its own argument-spread path, share
it with the call-spread path used by ordinary function calls.

### Step 5 — `tests/issue-1551.test.ts`

```ts
import { runCases, runThrows } from './harness';

runCases('issue-1551 super arg/spread/uninit-this', [
  ['arg-eval-err',
   `var thrown=new Error('e');var caught;
    class C extends Object{constructor(){try{super((()=>{throw thrown})())}catch(e){caught=e}}};
    try{new C()}catch{};caught===thrown ? 'ok' : 'fail'`, 'ok'],
  ['spread-getter-not-evaluated',
   `let ran=false;let o={a:1};
    class P{constructor(obj){this.k=Object.keys(obj).length}};
    class C extends P{constructor(){super({...o,get c(){ran=true}})}};
    String(new C().k)+'/'+ran`, '2/false'],
  ['uninit-this-putvalue',
   `class B{constructor(){throw 'base'}};
    class D extends B{constructor(){super[super()]=0}};
    let kind='none';try{new D()}catch(e){kind=e&&e.name||String(e)};kind`,
   'ReferenceError'],
]);
```

## Files to inspect

- `src/codegen/expressions/new-super.ts` — primary path for `super(...)`
  and `super.x` / `super[x]`.
- `src/codegen/class-bodies.ts` (around line 880-947, externref-backed
  subclass constructor) — implicit super lowering.
- `src/codegen/expressions/calls.ts` — argument-list spread lowering;
  reuse for super args.
- `src/codegen/expressions/object.ts` — `compileObjectExpression`
  spread + accessor descriptor copying.
- `src/runtime.ts` — `__copy_data_properties`, `__get_prototype_of`,
  ReferenceError throw helpers.

## Out of scope

- `super.method()` dispatch beyond the receiver-binding (covered by
  existing class method lowering).
- `new.target` propagation in `Reflect.construct` style calls — tracked
  separately.
- `super(...)` in object-literal methods (only legal inside class).

## Test files to verify

```
test/language/expressions/super/call-arg-evaluation-err.js
test/language/expressions/super/call-spread-obj-getter-init.js
test/language/expressions/super/call-spread-obj-symbol-property.js
test/language/expressions/super/call-spread-obj-undefined.js
test/language/expressions/super/call-spread-mult-literal.js
test/language/expressions/super/call-spread-sngl-obj-ident.js
test/language/expressions/super/prop-expr-cls-key-err.js
test/language/expressions/super/prop-expr-uninitialized-this-putvalue.js
test/language/expressions/super/prop-expr-uninitialized-this-putvalue-increment.js
test/language/expressions/super/prop-expr-getsuperbase-before-topropertykey-getvalue.js
```
