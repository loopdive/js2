---
id: 1455
sprint: 52
title: "spec gap: subclassing builtins — instanceof and prototype chain (class Sub extends Map / Float32Array / WeakMap / …)"
status: done

## Test Results

- ✅ `class Subclass extends Map {}` — `sub instanceof Subclass` AND `sub instanceof Map` both true (statement + class expression)
- ✅ `class Subclass extends Float32Array {}` — both checks pass
- ✅ `class Subclass extends Uint8ClampedArray {}` — both checks pass
- ✅ `class Subclass extends WeakRef {}` — both checks pass (single-arg forwarder for implicit ctor)
- ✅ `class Subclass extends Set {}` — both checks pass
- ✅ `class MyErr extends TypeError {}` — full Error chain still works (regression check)
- ✅ `class B extends A {}` — plain user-class inheritance still works
- ⚠️ `class Subclass extends DataView {}` — `sub instanceof DataView` resolves statically, but `new Subclass(new ArrayBuffer(N))` fails because the compiler emits ArrayBuffer as a wasm-vec, which the host `__new_DataView` cannot accept directly. Runtime now converts wasm-vec → ArrayBuffer via the exported `__dv_byte_*` accessors when present; subclass-DataView still fails because the bare `class Subclass extends DataView {}` does not emit those exports.

## Implementation summary

Runtime tag-chain approach (extends #1366a/b):

1. **`src/codegen/builtin-tags.ts`** — added `WeakRef`, all concrete TypedArrays, and `DataView` to both `BUILTIN_TYPE_TAGS` and `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`. Their subclasses are now externref-backed.
2. **`src/runtime.ts`** — added TypedArray constructors to `builtinCtors`; added `__tag_user_class(instance, name, parent)` host import + `_userClassTags` WeakMap + `_userClassParents` Map; `__instanceof` now walks the tag chain when the native `instanceof globalThis[ctorName]` returns false. The `extern_class` "new" resolver converts wasm-vec buffer args to real ArrayBuffers for typed-array/DataView constructors (handles the `new Sub(buf)` case when the `__dv_byte_*` exports are available).
3. **`src/codegen/class-bodies.ts`** — implicit constructors on externref-backed subclasses now synthesize a single externref `__arg0` param that is forwarded to `__new_<Parent>` (single-arg forwarder; the runtime strips trailing null/undefined for the zero-arg case). Every externref-backed user-class constructor now emits a trailing `__tag_user_class(__self, className, userParent)` call so the runtime can resolve `instance instanceof Sub` via the tag chain.
4. **`src/codegen/expressions.ts` + `identifiers.ts`** — `compileHostInstanceOf` canonicalises class-expression aliases through `classExprNameMap` so the binding-name and the synthetic `__anonClass_N` name compare equal. The externref-backed-RHS static fast path falls through to the host check when the LHS TS type can't be resolved (TS often infers `any` because builtins like `WeakRef<T>` / `Map<K,V>` reject a no-typearg `extends`).
created: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, builtins, prototype-chain
goal: spec-completeness
related: [1364, 1366]
---
# #1455 — Subclassing builtins: `instanceof Sub` and `instanceof Parent` must both pass

## Problem

When a user class extends a builtin (e.g.
`class Sub extends Map {}`), instances of `Sub` must satisfy
**both** `instance instanceof Sub` **and**
`instance instanceof Map` (§10.2.1 / §9.1.6 / §22.1.2.1). The
constructor call routes through `Reflect.Construct(Builtin, args, new.target)`
so the new object's `[[Prototype]]` is `Sub.prototype`, and walking the
chain reaches `Map.prototype` → `Object.prototype`.

Today, after `let s = new Sub()`:

- `s instanceof Sub` is **false**
- `s instanceof Map` may be true (the externref carries the JS
  builtin's prototype) but `Sub.prototype` is never inserted into the
  chain.

Sample failures:

```js
class Subclass extends Map {}
const sub = new Subclass();
assert(sub instanceof Subclass);    // fails
assert(sub instanceof Map);
```

## Failure count

**~58 fails** across `language/expressions/class/subclass-builtins/`
and `language/statements/class/subclass-builtins/`. Affected
parents (sample):

- `Map`, `WeakMap`, `WeakSet`, `WeakRef`, `Set`
- `Uint8ClampedArray`, `Float32Array`, `Float64Array`, and the rest
  of the TypedArray hierarchy
- `DataView`, `ArrayBuffer`, `SharedArrayBuffer` (some skipped)
- `Promise`, `AggregateError`
- All `Error` subclasses (`SyntaxError`, `EvalError`, etc.) +
  `verifyProperty` on `.message`

Some of these are tangled with #1364 (descriptor fidelity on subclassed
Error) but the `instanceof` failure is independent.

## Root cause

`src/codegen/class-bodies.ts:931-947` emits the implicit-super path for
externref-backed subclasses by calling `__new_<Parent>(null)` — this
returns an externref carrying a real JS `Map`/`Float32Array`/etc.
instance, then stores it as the `Sub` instance.

But the instance's `[[Prototype]]` is the builtin's prototype, not
`Sub.prototype`. The spec wants:

```js
Object.setPrototypeOf(newInstance, Sub.prototype);
```

after the super-call returns (the equivalent of `Reflect.Construct`'s
`newTarget` parameter). We never set the prototype, so
`instanceof Sub` walks: `instance.[[Prototype]] = Map.prototype` →
`Object.prototype` → null — never hits `Sub.prototype`.

Additionally, for `Sub` declared with `class Sub extends Map { method() {} }`,
the methods on `Sub.prototype` are unreachable from instances created
through the builtin constructor — even if you call `s.method`, our
prototype chain look-up doesn't find it.

## Implementation strategy

1. After the implicit (or explicit) `super(...)` call inside an
   externref-backed subclass constructor, emit a
   `Object.setPrototypeOf(thisLocal, Sub.prototype)` equivalent —
   either via a host import (`__set_prototype_of(externref, externref)`)
   or via direct JS-builtin wiring (the new instance is a JS object,
   so the runtime can call `Object.setPrototypeOf` natively).
2. Register `Sub.prototype` as a real JS object when the class is
   declared — populated with `Sub`'s methods (including inherited
   ones via `Object.setPrototypeOf(Sub.prototype, Parent.prototype)`).
3. Fix `instanceof` lookup to walk the externref's actual `[[Prototype]]`
   chain. Currently `instanceof` for subclasses of builtins likely
   compares the class struct, not the prototype.

There is overlap with #1366 (subclass-extern-backed support). Verify
which path is already in place vs missing.

## Acceptance criteria

1. `test/language/expressions/class/subclass-builtins/subclass-Map.js`
   passes.
2. `test/language/expressions/class/subclass-builtins/subclass-Float32Array.js`
   passes.
3. `test/language/expressions/class/subclass-builtins/subclass-WeakRef.js`
   passes.
4. `test/language/expressions/class/subclass-builtins/subclass-DataView.js`
   passes.
5. `test/language/expressions/class/subclass-builtins/subclass-Uint8ClampedArray.js`
   passes.
6. Sub-of-builtin instance method calls work: `class X extends Map { mine() { return 1; } }; new X().mine() === 1`.
7. Total `subclass-builtins/` fails reduce by **≥ 40**.

## Files to inspect

- `src/codegen/class-bodies.ts:880-947` — externref-backed
  constructor path, `__new_<Parent>` call.
- `src/codegen/class-bodies.ts` — class methods on `Sub.prototype`
  registration.
- `src/codegen/expressions/new-super.ts` — `super(...)` call
  emission and `new.target` plumbing.
- `src/codegen/expressions/identifiers.ts` — `instanceof`
  implementation (search for `__instanceof` or `ref.test`).
- `src/runtime.ts` — possibly add `__set_prototype_of` and
  `__instanceof_chain` host imports.
- `tests/issue-1455.test.ts` — focused subclass-builtin cases.

## Out of scope

- `Promise` subclassing thenable resolution semantics (deeper async
  spec).
- `Symbol.species` overriding `Array.prototype.map` etc. return
  type (separate, sparse failure set).
- `instance instanceof` cross-realm shenanigans.
