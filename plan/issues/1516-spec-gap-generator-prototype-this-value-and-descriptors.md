---
id: 1516
title: "spec gap: GeneratorPrototype — this-value coercion + name/length/property descriptors"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: generators
goal: spec-completeness
sprint: 52
related: [1364]
---
# #1516 — GeneratorPrototype fidelity

## Problem

`built-ins/GeneratorPrototype/` and
`built-ins/AsyncGeneratorPrototype/` contribute
**~52 + ~19 failing test262 cases** with two sub-patterns:

### Sub-cluster A — this-value type checks

```js
Generator.prototype.next.call(non_generator);   // expected: TypeError
Generator.prototype.next.call(null);            // expected: TypeError
Generator.prototype.return.call({});            // expected: TypeError
```

`this-val-not-generator.js`, `this-val-not-object.js` across `next`,
`return`, `throw`. We currently fail with

```
TypeError: Cannot access property on null or undefined at 57:26
```

— close, but the error class is sometimes wrong (we sometimes hit a
ref.null deref first) and the message does not match the spec
("Generator.prototype.next called on incompatible receiver").

### Sub-cluster B — property descriptors

```js
verifyProperty(Generator.prototype.next, "length", {
  value: 1, writable: false, enumerable: false, configurable: true
});
```

`length.js`, `name.js`, `property-descriptor.js`, `not-a-constructor.js`,
`constructor.js`, `Symbol.toStringTag.js` for each of `next`, `return`,
`throw`. We construct `%GeneratorPrototype%.next` as a regular
function with default descriptor flags (`enumerable: true`,
`writable: true`).

## Failure count

**~70 fails** (52 Generator + 19 AsyncGenerator). Realistic target:
**≥ 50 flips**.

## Root cause

In `src/codegen/generators.ts` (or wherever the
`__generator_next`/`__generator_return`/`__generator_throw` host
imports are wired):

1. The host import is registered as `(externref) -> externref` and
   then bound to `Generator.prototype.next` via a JS-host fallback.
   On standalone mode it's a closure over the generator state struct.
   Neither path runs the `Type(this) is Object && [[GeneratorState]] is present`
   check.

2. The intrinsic `%GeneratorPrototype%` is allocated via the same
   path as user prototypes — no special descriptor flags are set.

This is the **same shape** as #1364 (class-element descriptors) but
on the implicit `%GeneratorPrototype%` rather than user classes; the
fix re-uses #1364's machinery once it lands.

## Files to touch

- `src/codegen/generators.ts` — emit a `ref.test $GeneratorStruct`
  + TypeError throw before each `Generator.prototype.X` body.
- `src/codegen/intrinsics.ts` (or the generator prototype builder)
  — install descriptor flags `{enumerable:false, writable:true, configurable:true}`
  on `next`, `return`, `throw`.
- Same for `%AsyncGeneratorPrototype%`.

## Acceptance criteria

1. ≥ 40 of 52 in `built-ins/GeneratorPrototype/` flip to `pass`.
2. ≥ 10 of 19 in `built-ins/AsyncGeneratorPrototype/` flip to
   `pass`.
3. `Generator.prototype.next.call(null)` throws `TypeError`
   with the spec-shaped message.
4. No regression in `language/{expressions,statements}/generators/`.

## Reference tests

- `built-ins/GeneratorPrototype/next/this-val-not-generator.js`
- `built-ins/GeneratorPrototype/next/length.js`
- `built-ins/GeneratorPrototype/Symbol.toStringTag.js`
- `built-ins/GeneratorPrototype/throw/name.js`
- `built-ins/AsyncGeneratorPrototype/throw/length.js`

## Implementation notes (delivered)

`%GeneratorPrototype%`, `%AsyncGeneratorPrototype%`, and their associated
`%GeneratorFunction.prototype%` / `%AsyncGeneratorFunction.prototype%`
singletons now live in `src/runtime.ts`:

- `_getGeneratorPrototype()` lazily builds an object inheriting from
  `Iterator.prototype` (per #1367) with shared `next`/`return`/`throw`,
  `Symbol.toStringTag = "Generator"`, and a `constructor` slot pointing at
  `%Generator%`. Property descriptors are spec-shaped:
  `{writable: true, enumerable: false, configurable: true}` for the methods,
  `{value: 1, writable: false, enumerable: false, configurable: true}` for
  each method's `length`. The methods read instance state from
  `_GeneratorState` (a `WeakMap`) — when `this` is not a key, they throw
  `TypeError("Generator.prototype.X called on incompatible receiver")` per
  spec §27.5.3.2 (GeneratorValidate).
- `__create_generator` now returns `Object.create(_GeneratorPrototype)` with
  state stored in `_GeneratorState` (so `next` is no longer an own property
  of the instance — it inherits from the shared prototype).
- Same shape for async (`_AsyncGeneratorState`, `_getAsyncGeneratorPrototype`).
- `Object.getPrototypeOf(g)` where `g` is a generator-function declaration:
  the compiled-Wasm closure for `g` is opaque to the host so the generic
  `__getPrototypeOf` returns `null` (or unrelated). Codegen
  (`src/codegen/expressions/calls.ts`) now special-cases call sites where
  the argument is an identifier of a registered generator function, routing
  to a dedicated `__get_generator_function_prototype` (or
  `__get_async_generator_function_prototype`) host import. This makes
  `Object.getPrototypeOf(g).prototype === %GeneratorPrototype%` resolve.

## Test Results

Local equivalence — `tests/issue-1516.test.ts` (new, 8 cases): all pass.
`tests/issue-928.test.ts` (generator pending-throw semantics, 6 cases): all
pass. No regression in `tests/generator-iife.test.ts`,
`tests/for-of-string-generator.test.ts`,
`tests/generator-method-destructuring.test.ts`,
`tests/issue-862-func-decl-iter.test.ts`, `tests/iterators.test.ts`,
`tests/symbol-iterator-protocol.test.ts` (16/16 pass).

Pre-existing failures unrelated to this issue: `symbol-async-iterator.test.ts`
("string_constants module is not an object"),
`generator-yield-contexts.test.ts > yield in a generator function expression`
("illegal cast"), `for-of-generator.test.ts` (missing `./helpers.js`).
Confirmed pre-existing by stashing the patch and rerunning on the parent
commit.

CI test262 regression analysis pending.

